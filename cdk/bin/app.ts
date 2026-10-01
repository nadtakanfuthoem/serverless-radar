#!/usr/bin/env node
import 'source-map-support/register';
import { config } from 'dotenv';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { ServerlessRadarStack } from '../lib/serverless-radar-stack';

// Load .env from project root
config({ path: path.resolve(__dirname, '../../.env') });

const app = new cdk.App();

// Resolve the target account/region. HostedZone.fromLookup requires a concrete
// account + region, so an environment-agnostic stack is not allowed here.
// Prefer the CLI-provided defaults (from active AWS credentials), then fall
// back to AWS_ACCOUNT_ID / AWS_REGION from .env.
const account = process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID;
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';

if (!account) {
  throw new Error(
    'No AWS account resolved. Set AWS_ACCOUNT_ID in .env, or run with resolvable ' +
    'AWS credentials (e.g. `AWS_PROFILE=<profile> cdk deploy`) so the CDK CLI can ' +
    'populate CDK_DEFAULT_ACCOUNT.'
  );
}

new ServerlessRadarStack(app, 'ServerlessRadarStack', {
  env: { account, region },
  description: 'Serverless Radar — AWS RSS feed tracker for serverless announcements',
});
