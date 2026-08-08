// Tests for the recursive nested layout — the acceptance criterion for the whole draggable-canvas
// feature (see the plan's "Why: the acceptance criterion"). Run with:
// node --test lib/design-layout.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDagreLayout, applyNestedLayout, estimateNodeHeight } from './design-layout.ts';
import { architectureToDesignGraph, parseArchitectureDiagram } from './mermaid-architecture.ts';
import type { DesignNode } from './design-graph.ts';

const SERVERLESS_API = `architecture-beta
    group aws(logos:aws)["AWS Cloud"]
    service api(logos:aws-api-gateway)["API Gateway"] in aws
    service compute(logos:aws-lambda)["Lambda"] in aws
    service storage(logos:aws-s3)["S3 Storage"] in aws
    service database(logos:aws-rds)["Postgres RDS"] in aws

    api:R --> L:compute
    compute:R --> L:storage
    compute:R --> L:database`;

const WIDE_MICROSERVICES = `architecture-beta
group edge(logos:aws)["Edge and API"]
service cloudfront(logos:aws-cloudfront)["CloudFront"] in edge
service apigw(logos:aws-api-gateway)["API Gateway"] in edge
service cognito(logos:aws-cognito)["Cognito"] in edge

group platform(logos:aws)["Microservices Platform"]
service orders(logos:aws-lambda)["Orders Lambda"] in platform
service inventory(logos:aws-lambda)["Inventory Lambda"] in platform
service payments(logos:aws-lambda)["Payments Lambda"] in platform
service users(logos:aws-lambda)["Users Lambda"] in platform
service assets(logos:aws-s3)["S3 Assets"] in platform
service dynamodb(logos:aws-dynamodb)["DynamoDB"] in platform
service rds(logos:aws-rds)["RDS"] in platform
service sqs(logos:aws-sqs)["SQS"] in platform
service sns(logos:aws-sns)["SNS"] in platform
service cloudwatch(logos:aws-cloudwatch)["CloudWatch"] in platform
service cache(logos:aws-elasticache)["ElastiCache"] in platform

cloudfront:R --> L:apigw
cloudfront:B --> T:assets
cognito:R --> L:apigw
apigw:R --> L:orders
apigw:B --> T:inventory
apigw:R --> L:payments
apigw:B --> T:users
orders:R --> L:dynamodb
orders:B --> T:sqs
orders:R --> L:cache
inventory:R --> L:dynamodb
inventory:B --> T:sqs
payments:R --> L:rds
payments:B --> T:sns
users:R --> L:rds
users:B --> T:dynamodb
sqs:R --> L:inventory
sns:R --> L:orders
cloudwatch:T --> B:orders
cloudwatch:T --> B:inventory
cloudwatch:T --> B:payments
cloudwatch:T --> B:users`;

const AWS_AGENTCORE_AMPLIFY = `architecture-beta
    group amplify(logos:aws-amplify)["Amplify Gen2 Backend"]
    group agentcore(logos:aws)["Bedrock AgentCore"]

    service user(logos:aws)["User Browser"]
    service nextapp(logos:aws)["Next.js App"]
    service cognito(logos:aws-cognito)["Cognito"] in amplify
    service appsync(logos:aws-appsync)["AppSync API"] in amplify
    service dynamodb(logos:aws-dynamodb)["DynamoDB"] in amplify
    service invokefn(logos:aws-lambda)["Invocations Lambda"] in amplify
    service runtime(logos:aws)["AgentCore Runtime"] in agentcore
    service mcp(logos:aws)["MCP Gateways"] in agentcore
    service paymgr(logos:aws)["Payment Manager"] in agentcore
    service payconn(logos:aws)["Payment Connectors"] in agentcore

    user:R --> L:nextapp
    nextapp:R --> L:cognito
    nextapp:T --> B:appsync
    appsync:R --> L:dynamodb
    nextapp:B --> T:invokefn
    invokefn:R --> L:runtime
    cognito:B --> T:runtime
    runtime:R --> L:mcp
    runtime:B --> T:paymgr
    paymgr:R --> L:payconn`;

// 3-level synthetic covering every nesting depth the grammar allows: group > group > service.
const THREE_LEVEL_SYNTHETIC = `architecture-beta
group outer(logos:aws)["Outer Region"]
group inner(logos:aws)["Inner VPC"] in outer
service a(logos:aws-lambda)["Service A"] in inner
service b(logos:aws-s3)["Service B with a longer name that wraps"] in inner
service c(logos:aws-rds)["Service C"] in outer
junction j in inner
a:R --> L:b
b:R --> T:j
j:R --> L:c`;

function nodeWidth(node: DesignNode): number {
  if (node.type === 'group') return node.width ?? 0;
  if (node.type === 'junction') return node.width ?? 12;
  return node.width ?? 96;
}

function nodeHeight(node: DesignNode): number {
  if (node.type === 'group') return node.height ?? 0;
  if (node.type === 'junction') return node.height ?? 12;
  return node.height ?? estimateNodeHeight(node.data.label);
}

/** Every child's position + size must be fully inside its parent's derived size — the
 * acceptance criterion: a node can never straddle its group's border, by construction. */
function countStraddles(nodes: DesignNode[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let count = 0;
  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = byId.get(node.parentId);
    if (!parent) continue;
    const w = nodeWidth(node);
    const h = nodeHeight(node);
    const pw = nodeWidth(parent);
    const ph = nodeHeight(parent);
    const { x, y } = node.position; // already parent-relative
    if (x < 0 || y < 0 || x + w > pw || y + h > ph) count++;
  }
  return count;
}

function absolutePosition(node: DesignNode, byId: Map<string, DesignNode>): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let current = node;
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    current = parent;
  }
  return { x, y };
}

/** No two service nodes' 144px label boxes (the effective footprint — see design-node.tsx's
 * `-mx-6 w-[144px]`) may intersect in absolute coordinates. */
function countLabelCollisions(nodes: DesignNode[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const boxes = nodes
    .filter((n) => n.type === 'design')
    .map((n) => {
      const abs = absolutePosition(n, byId);
      const height = nodeHeight(n);
      return { left: abs.x - 24, right: abs.x + 96 + 24, top: abs.y, bottom: abs.y + height };
    });
  let collisions = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapsX = a.left < b.right && b.left < a.right;
      const overlapsY = a.top < b.bottom && b.top < a.bottom;
      if (overlapsX && overlapsY) collisions++;
    }
  }
  return collisions;
}

for (const [name, source] of [
  ['serverless API', SERVERLESS_API],
  ['wide microservices platform', WIDE_MICROSERVICES],
  ['AWS AgentCore + Amplify', AWS_AGENTCORE_AMPLIFY],
  ['3-level synthetic', THREE_LEVEL_SYNTHETIC],
] as const) {
  test(`applyNestedLayout: ${name} has 0 straddles and 0 label collisions`, () => {
    const parse = parseArchitectureDiagram(source);
    assert.deepEqual(parse.issues, []);
    const graph = architectureToDesignGraph(parse);
    const laidOut = applyNestedLayout(graph.nodes, graph.edges);
    assert.equal(countStraddles(laidOut), 0, `${name}: straddle === 0 is the acceptance criterion`);
    assert.equal(countLabelCollisions(laidOut), 0, `${name}: no two service label boxes may overlap`);
  });
}

test('applyDagreLayout (freeform top-level-only) behavior is unchanged: simple 2-node LR case', () => {
  const nodes: DesignNode[] = [
    { id: 'a', type: 'design', position: { x: 0, y: 0 }, data: { label: 'A' } },
    { id: 'b', type: 'design', position: { x: 0, y: 0 }, data: { label: 'B' } },
  ];
  const edges = [{ id: 'e1', source: 'a', target: 'b' }];
  const out = applyDagreLayout(nodes, edges);
  const a = out.find((n) => n.id === 'a')!;
  const b = out.find((n) => n.id === 'b')!;
  assert.deepEqual(a.position, { x: 0, y: 0 });
  assert.deepEqual(b.position, { x: 176, y: 0 });
});

test('estimateNodeHeight grows with authored \\n line count and long single lines', () => {
  const oneLine = estimateNodeHeight('Short');
  const twoLines = estimateNodeHeight('Service name\nResource name');
  const longWrapped = estimateNodeHeight('A'.repeat(50));
  assert.ok(twoLines > oneLine);
  assert.ok(longWrapped > oneLine);
});
