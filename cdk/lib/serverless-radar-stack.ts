import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as path from 'path';
import { config } from 'dotenv';
import { Construct } from 'constructs';

// Load .env from project root
config({ path: path.resolve(__dirname, '../../.env') });

const DOMAIN_NAME = process.env.DOMAIN_NAME || 'example.com';
const SUBDOMAIN = process.env.SUBDOMAIN || `serverless-radar.${DOMAIN_NAME}`;
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || '';

export class ServerlessRadarStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Route 53 hosted zone (must already exist)
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: DOMAIN_NAME,
    });

    // ACM certificate (must be in us-east-1 for CloudFront)
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: SUBDOMAIN,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // S3 bucket — hosts static website only
    const bucket = new s3.Bucket(this, 'ServerlessRadarBucket', {
      bucketName: `serverless-radar-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // DynamoDB table — stores filtered RSS data
    const table = new dynamodb.Table(this, 'ServerlessRadarTable', {
      tableName: 'serverless-radar',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },  // "2026#06"
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },       // link URL
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // API Lambda — reads from DynamoDB, serves JSON to the frontend
    const apiFunction = new lambda.Function(this, 'ServerlessRadarApiFunction', {
      functionName: 'serverless-radar-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'api.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      description: 'API to query serverless announcements from DynamoDB',
      environment: {
        TABLE_NAME: table.tableName,
      },
    });

    table.grantReadData(apiFunction);

    // Function URL for the API (public, no auth — read-only data)
    const apiUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET],
        allowedHeaders: ['*'],
      },
    });

    // CloudFront Origin Access Control for S3
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    // CloudFront distribution — serves static site + proxies /api to Lambda
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [SUBDOMAIN],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // Route 53 A record pointing to CloudFront
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: SUBDOMAIN,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
    });

    // Deploy web UI to S3
    new s3deploy.BucketDeployment(this, 'DeployWebUI', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../web'))],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // SNS topic for email notifications
    const topic = new sns.Topic(this, 'ServerlessRadarTopic', {
      topicName: 'serverless-radar-notifications',
      displayName: 'Serverless Radar',
    });

    if (NOTIFICATION_EMAIL) {
      topic.addSubscription(
        new subscriptions.EmailSubscription(NOTIFICATION_EMAIL)
      );
    }

    // Fetcher Lambda — fetches RSS and saves to DynamoDB
    const radarFunction = new lambda.Function(this, 'ServerlessRadarFunction', {
      functionName: 'serverless-radar',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Fetches AWS RSS feed and saves serverless announcements to DynamoDB',
      environment: {
        TABLE_NAME: table.tableName,
        TOPIC_ARN: topic.topicArn,
      },
      logGroup: new logs.LogGroup(this, 'ServerlessRadarLogGroup', {
        logGroupName: '/aws/lambda/serverless-radar',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant fetcher Lambda read+write access to DynamoDB
    table.grantReadWriteData(radarFunction);

    // Grant fetcher Lambda publish access to SNS
    topic.grantPublish(radarFunction);

    // EventBridge rule — runs twice daily at 9:00 AM and 9:00 PM UTC
    const schedule = new events.Rule(this, 'ServerlessRadarSchedule', {
      ruleName: 'serverless-radar-daily',
      description: 'Triggers Serverless Radar Lambda twice daily at 9:00 AM and 9:00 PM UTC',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '9,21',
        day: '*',
        month: '*',
        year: '*',
      }),
    });

    schedule.addTarget(new targets.LambdaFunction(radarFunction));

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${SUBDOMAIN}`,
      description: 'Website URL',
    });

    new cdk.CfnOutput(this, 'ApiURL', {
      value: `https://${SUBDOMAIN}/api/items`,
      description: 'API endpoint for querying items',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: radarFunction.functionName,
      description: 'Fetcher Lambda function name',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'SNS topic ARN for notifications',
    });
  }
}
