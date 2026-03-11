import { CloudWatchClient, DescribeAlarmsCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  EC2Client,
  RebootInstancesCommand,
  RevokeSecurityGroupIngressCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { IAMClient, ListAccountAliasesCommand, ListPoliciesCommand, ListRolesCommand, ListUsersCommand } from '@aws-sdk/client-iam';
import { GetFunctionCommand, InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { DescribeDBInstancesCommand, RDSClient, RebootDBInstanceCommand, StartDBInstanceCommand, StopDBInstanceCommand } from '@aws-sdk/client-rds';
import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
} from '@aws-sdk/client-route-53';
import { DeleteObjectCommand, GetObjectCommand, ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export interface AwsInstanceConfig {
  id: string;
  name: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoints?: {
    sts?: string;
    ec2?: string;
    s3?: string;
    route53?: string;
    lambda?: string;
    cloudwatch?: string;
    cloudwatchLogs?: string;
    rds?: string;
    iam?: string;
    costExplorer?: string;
  };
}

export class AwsClient {
  readonly config: AwsInstanceConfig;

  constructor(config: AwsInstanceConfig) {
    this.config = { ...config };
  }

  async getCallerIdentity(): Promise<unknown> {
    return this.sts().send(new GetCallerIdentityCommand({}));
  }

  async listAccountAliases(): Promise<unknown> {
    return this.iam().send(new ListAccountAliasesCommand({}));
  }

  async listEc2Instances(input: {
    instanceIds?: string[];
    state?: string;
    tagKey?: string;
    tagValue?: string;
  }): Promise<unknown> {
    const filters = [];
    if (input.state) {
      filters.push({ Name: 'instance-state-name', Values: [input.state] });
    }
    if (input.tagKey && input.tagValue) {
      filters.push({ Name: `tag:${input.tagKey}`, Values: [input.tagValue] });
    }
    return this.ec2().send(new DescribeInstancesCommand({
      InstanceIds: input.instanceIds?.length ? input.instanceIds : undefined,
      Filters: filters.length ? filters : undefined,
    }));
  }

  async startEc2Instances(instanceIds: string[]): Promise<unknown> {
    return this.ec2().send(new StartInstancesCommand({ InstanceIds: instanceIds }));
  }

  async stopEc2Instances(instanceIds: string[], force?: boolean): Promise<unknown> {
    return this.ec2().send(new StopInstancesCommand({ InstanceIds: instanceIds, Force: force }));
  }

  async rebootEc2Instances(instanceIds: string[]): Promise<unknown> {
    return this.ec2().send(new RebootInstancesCommand({ InstanceIds: instanceIds }));
  }

  async listSecurityGroups(groupIds?: string[]): Promise<unknown> {
    return this.ec2().send(new DescribeSecurityGroupsCommand({
      GroupIds: groupIds?.length ? groupIds : undefined,
    }));
  }

  async authorizeSecurityGroupIngress(input: {
    groupId: string;
    protocol: string;
    fromPort?: number;
    toPort?: number;
    cidr?: string;
    description?: string;
  }): Promise<unknown> {
    return this.ec2().send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: input.groupId,
      IpPermissions: [{
        IpProtocol: input.protocol,
        FromPort: input.fromPort,
        ToPort: input.toPort,
        IpRanges: input.cidr ? [{ CidrIp: input.cidr, Description: input.description }] : undefined,
      }],
    }));
  }

  async revokeSecurityGroupIngress(input: {
    groupId: string;
    protocol: string;
    fromPort?: number;
    toPort?: number;
    cidr?: string;
    description?: string;
  }): Promise<unknown> {
    return this.ec2().send(new RevokeSecurityGroupIngressCommand({
      GroupId: input.groupId,
      IpPermissions: [{
        IpProtocol: input.protocol,
        FromPort: input.fromPort,
        ToPort: input.toPort,
        IpRanges: input.cidr ? [{ CidrIp: input.cidr, Description: input.description }] : undefined,
      }],
    }));
  }

  async listS3Buckets(): Promise<unknown> {
    return this.s3().send(new ListBucketsCommand({}));
  }

  async listS3Objects(bucket: string, input: { prefix?: string; maxKeys?: number }): Promise<unknown> {
    return this.s3().send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: input.prefix,
      MaxKeys: input.maxKeys,
    }));
  }

  async getS3ObjectText(bucket: string, key: string): Promise<{ metadata: unknown; bodyText: string }> {
    const result = await this.s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = result.Body as { transformToString?: () => Promise<string> } | undefined;
    const bodyText = body?.transformToString ? await body.transformToString() : '';
    return {
      metadata: {
        contentType: result.ContentType,
        contentLength: result.ContentLength,
        eTag: result.ETag,
        lastModified: result.LastModified,
      },
      bodyText,
    };
  }

  async putS3ObjectText(bucket: string, key: string, body: string, contentType?: string): Promise<unknown> {
    return this.s3().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
  }

  async deleteS3Object(bucket: string, key: string): Promise<unknown> {
    return this.s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async listHostedZones(): Promise<unknown> {
    return this.route53().send(new ListHostedZonesCommand({}));
  }

  async listRoute53Records(hostedZoneId: string, input: { startName?: string; maxItems?: number }): Promise<unknown> {
    return this.route53().send(new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: input.startName,
      MaxItems: input.maxItems,
    }));
  }

  async changeRoute53Records(hostedZoneId: string, changes: Array<Record<string, unknown>>): Promise<unknown> {
    return this.route53().send(new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: changes as never,
      },
    }));
  }

  async listLambdaFunctions(maxItems?: number): Promise<unknown> {
    return this.lambda().send(new ListFunctionsCommand({ MaxItems: maxItems }));
  }

  async getLambdaFunction(functionName: string): Promise<unknown> {
    return this.lambda().send(new GetFunctionCommand({ FunctionName: functionName }));
  }

  async invokeLambda(functionName: string, input: { payload?: string; invocationType?: string }): Promise<{ statusCode?: number; executedVersion?: string; payloadText: string }> {
    const result = await this.lambda().send(new InvokeCommand({
      FunctionName: functionName,
      Payload: input.payload ? new TextEncoder().encode(input.payload) : undefined,
      InvocationType: input.invocationType as 'Event' | 'RequestResponse' | 'DryRun' | undefined,
    }));
    const payloadText = result.Payload ? new TextDecoder().decode(result.Payload) : '';
    return {
      statusCode: result.StatusCode,
      executedVersion: result.ExecutedVersion,
      payloadText,
    };
  }

  async listMetrics(input: { namespace?: string; metricName?: string; dimensions?: Array<{ Name: string; Value: string }> }): Promise<unknown> {
    return this.cloudwatch().send(new ListMetricsCommand({
      Namespace: input.namespace,
      MetricName: input.metricName,
      Dimensions: input.dimensions,
    }));
  }

  async describeAlarms(alarmNamePrefix?: string): Promise<unknown> {
    return this.cloudwatch().send(new DescribeAlarmsCommand({
      AlarmNamePrefix: alarmNamePrefix,
    }));
  }

  async filterLogEvents(input: {
    logGroupName: string;
    filterPattern?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<unknown> {
    return this.cloudwatchLogs().send(new FilterLogEventsCommand({
      logGroupName: input.logGroupName,
      filterPattern: input.filterPattern,
      startTime: input.startTime,
      endTime: input.endTime,
      limit: input.limit,
    }));
  }

  async listRdsInstances(): Promise<unknown> {
    return this.rds().send(new DescribeDBInstancesCommand({}));
  }

  async startRdsInstance(identifier: string): Promise<unknown> {
    return this.rds().send(new StartDBInstanceCommand({ DBInstanceIdentifier: identifier }));
  }

  async stopRdsInstance(identifier: string): Promise<unknown> {
    return this.rds().send(new StopDBInstanceCommand({ DBInstanceIdentifier: identifier }));
  }

  async rebootRdsInstance(identifier: string, forceFailover?: boolean): Promise<unknown> {
    return this.rds().send(new RebootDBInstanceCommand({
      DBInstanceIdentifier: identifier,
      ForceFailover: forceFailover,
    }));
  }

  async listIamUsers(maxItems?: number): Promise<unknown> {
    return this.iam().send(new ListUsersCommand({ MaxItems: maxItems }));
  }

  async listIamRoles(maxItems?: number): Promise<unknown> {
    return this.iam().send(new ListRolesCommand({ MaxItems: maxItems }));
  }

  async listIamPolicies(input: { scope?: string; maxItems?: number }): Promise<unknown> {
    return this.iam().send(new ListPoliciesCommand({
      Scope: input.scope as 'AWS' | 'Local' | 'All' | undefined,
      MaxItems: input.maxItems,
    }));
  }

  async getCostAndUsage(input: {
    timePeriod: { Start: string; End: string };
    granularity: string;
    metrics: string[];
    groupBy?: Array<{ Type: string; Key: string }>;
  }): Promise<unknown> {
    return this.costExplorer().send(new GetCostAndUsageCommand({
      TimePeriod: input.timePeriod,
      Granularity: input.granularity as 'DAILY' | 'MONTHLY' | 'HOURLY',
      Metrics: input.metrics,
      GroupBy: input.groupBy as Array<{ Type: 'DIMENSION' | 'TAG' | 'COST_CATEGORY'; Key: string }> | undefined,
    }));
  }

  private sts(): STSClient {
    return new STSClient(this.baseOptions('sts', this.config.region));
  }

  private ec2(): EC2Client {
    return new EC2Client(this.baseOptions('ec2', this.config.region));
  }

  private s3(): S3Client {
    return new S3Client(this.baseOptions('s3', this.config.region));
  }

  private route53(): Route53Client {
    return new Route53Client(this.baseOptions('route53', 'us-east-1'));
  }

  private lambda(): LambdaClient {
    return new LambdaClient(this.baseOptions('lambda', this.config.region));
  }

  private cloudwatch(): CloudWatchClient {
    return new CloudWatchClient(this.baseOptions('cloudwatch', this.config.region));
  }

  private cloudwatchLogs(): CloudWatchLogsClient {
    return new CloudWatchLogsClient(this.baseOptions('cloudwatchLogs', this.config.region));
  }

  private rds(): RDSClient {
    return new RDSClient(this.baseOptions('rds', this.config.region));
  }

  private iam(): IAMClient {
    return new IAMClient(this.baseOptions('iam', 'us-east-1'));
  }

  private costExplorer(): CostExplorerClient {
    return new CostExplorerClient(this.baseOptions('costExplorer', 'us-east-1'));
  }

  private baseOptions(service: keyof NonNullable<AwsInstanceConfig['endpoints']>, region: string): {
    region: string;
    credentials?: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    endpoint?: string;
  } {
    return {
      region,
      credentials: this.config.accessKeyId && this.config.secretAccessKey
        ? {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
          sessionToken: this.config.sessionToken,
        }
        : undefined,
      endpoint: this.config.endpoints?.[service],
    };
  }
}
