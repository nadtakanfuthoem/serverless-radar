import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

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

    // S3 bucket — stores JSON data + web assets (private, served via CloudFront)
    const bucket = new s3.Bucket(this, 'ServerlessRadarBucket', {
      bucketName: `serverless-radar-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Origin Access Identity
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: 'Serverless Radar OAI',
    });
    bucket.grantRead(oai);

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [SUBDOMAIN],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new origins.S3Origin(bucket, { originAccessIdentity: oai }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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

    topic.addSubscription(
      new subscriptions.EmailSubscription(NOTIFICATION_EMAIL)
    );

    // Lambda function
    const radarFunction = new lambda.Function(this, 'ServerlessRadarFunction', {
      functionName: 'serverless-radar',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'Fetches AWS RSS feed and saves serverless announcements to S3',
      environment: {
        BUCKET_NAME: bucket.bucketName,
        TOPIC_ARN: topic.topicArn,
        NODE_OPTIONS: '--experimental-vm-modules',
      },
      logGroup: new logs.LogGroup(this, 'ServerlessRadarLogGroup', {
        logGroupName: '/aws/lambda/serverless-radar',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant Lambda write access to S3
    bucket.grantPut(radarFunction, 'data/*');

    // Grant Lambda publish access to SNS
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

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: radarFunction.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.topicArn,
      description: 'SNS topic ARN for notifications',
    });
  }
}
