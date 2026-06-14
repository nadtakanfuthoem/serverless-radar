#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ServerlessRadarStack } from '../lib/serverless-radar-stack';

const app = new cdk.App();

new ServerlessRadarStack(app, 'ServerlessRadarStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Serverless Radar — AWS RSS feed tracker for serverless announcements',
});
