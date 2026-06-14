import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export class ServerlessRadarStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket — stores JSON data + hosts the static website
    const bucket = new s3.Bucket(this, 'ServerlessRadarBucket', {
      bucketName: `serverless-radar-${this.account}-${this.region}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
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

    // Deploy web UI to S3
    new s3deploy.BucketDeployment(this, 'DeployWebUI', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../web'))],
      destinationBucket: bucket,
    });

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
        NODE_OPTIONS: '--experimental-vm-modules',
      },
      logGroup: new logs.LogGroup(this, 'ServerlessRadarLogGroup', {
        logGroupName: '/aws/lambda/serverless-radar',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant Lambda write access to the data/ prefix only
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${bucket.bucketArn}/data/*`],
      principals: [new iam.ArnPrincipal(radarFunction.role!.roleArn)],
    }));
    bucket.grantPut(radarFunction, 'data/*');

    // EventBridge rule — runs every day at 9:00 AM UTC
    const schedule = new events.Rule(this, 'ServerlessRadarSchedule', {
      ruleName: 'serverless-radar-daily',
      description: 'Triggers Serverless Radar Lambda daily at 9:00 AM UTC',
      schedule: events.Schedule.cron({
        minute: '0',
        hour: '9',
        day: '*',
        month: '*',
        year: '*',
      }),
    });

    schedule.addTarget(new targets.LambdaFunction(radarFunction));

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: bucket.bucketWebsiteUrl,
      description: 'S3 static website URL',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: radarFunction.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: `/aws/lambda/serverless-radar`,
      description: 'CloudWatch log group',
    });
  }
}
