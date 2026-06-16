#!/usr/bin/env node
import 'source-map-support/register';
import { config } from 'dotenv';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { ServerlessRadarStack } from '../lib/serverless-radar-stack';

// Load .env from project root
config({ path: path.resolve(__dirname, '../../.env') });

const app = new cdk.App();

new ServerlessRadarStack(app, 'ServerlessRadarStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
  },
  description: 'Serverless Radar — AWS RSS feed tracker for serverless announcements',
});
