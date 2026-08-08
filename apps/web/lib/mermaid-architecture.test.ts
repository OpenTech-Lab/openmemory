// Tests for the architecture-beta parser. Run with:
// node --test lib/mermaid-architecture.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { architectureToDesignGraph, isArchitectureSource, parseArchitectureDiagram } from './mermaid-architecture.ts';

// Real fixtures, pulled verbatim via:
// docker exec openmemory-postgres-1 psql -U openmemory -d openmemory -t -A -c \
//   "select source from project_designs where id='<id>';"
// (project af9ffd44-19d7-4a0b-ad44-1bbca6542bca for the first two, c1471c75-c8da-4b5f-91af-40a80ca8727e for the third)

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

function counts(parse: ReturnType<typeof parseArchitectureDiagram>) {
  return {
    nodes: parse.groups.length + parse.services.length + parse.junctions.length,
    groups: parse.groups.length,
    edges: parse.edges.length,
  };
}

test('real fixture: serverless API — 5 nodes, 1 group, 3 edges, 0 issues', () => {
  const parse = parseArchitectureDiagram(SERVERLESS_API);
  assert.equal(parse.ok, true);
  assert.deepEqual(counts(parse), { nodes: 5, groups: 1, edges: 3 });
  assert.deepEqual(parse.issues, []);
});

test('real fixture: wide microservices platform — 16 nodes, 2 groups, 22 edges, 0 issues', () => {
  const parse = parseArchitectureDiagram(WIDE_MICROSERVICES);
  assert.equal(parse.ok, true);
  assert.deepEqual(counts(parse), { nodes: 16, groups: 2, edges: 22 });
  assert.deepEqual(parse.issues, []);
});

test('real fixture: AWS AgentCore + Amplify — 12 nodes, 2 groups, 10 edges, 0 issues', () => {
  const parse = parseArchitectureDiagram(AWS_AGENTCORE_AMPLIFY);
  assert.equal(parse.ok, true);
  assert.deepEqual(counts(parse), { nodes: 12, groups: 2, edges: 10 });
  assert.deepEqual(parse.issues, []);
});

test('architectureToDesignGraph produces parents before children for all three real fixtures', () => {
  for (const source of [SERVERLESS_API, WIDE_MICROSERVICES, AWS_AGENTCORE_AMPLIFY]) {
    const graph = architectureToDesignGraph(parseArchitectureDiagram(source));
    const seen = new Set<string>();
    for (const node of graph.nodes) {
      if (node.parentId) assert.ok(seen.has(node.parentId), `${node.id}'s parent ${node.parentId} must precede it`);
      seen.add(node.id);
    }
  }
});

test('edge label is extracted from between the dashes: api:R -[invoke]-> L:fn', () => {
  const source = `architecture-beta
service api(logos:aws-api-gateway)["API"]
service fn(logos:aws-lambda)["Fn"]
api:R -[invoke]-> L:fn`;
  const parse = parseArchitectureDiagram(source);
  assert.deepEqual(parse.issues, []);
  assert.equal(parse.edges.length, 1);
  assert.equal(parse.edges[0].label, 'invoke');
});

test('--> vs <-- vs <--> set markers correctly', () => {
  const source = `architecture-beta
service a(logos:aws)["A"]
service b(logos:aws)["B"]
service c(logos:aws)["C"]
service d(logos:aws)["D"]
service e(logos:aws)["E"]
service f(logos:aws)["F"]
a:R --> L:b
c:R <-- L:d
e:R <--> L:f`;
  const graph = architectureToDesignGraph(parseArchitectureDiagram(source));
  const byPair = new Map(graph.edges.map((e) => [`${e.source}->${e.target}`, e]));

  const forward = byPair.get('a->b');
  assert.ok(forward);
  assert.deepEqual(forward!.markerEnd, { type: 'arrowclosed' });
  assert.equal(forward!.markerStart, undefined);

  // "c:R <-- L:d" points into c (the declared source) — endpoints swap so only markerEnd is set,
  // and the true React Flow source becomes d.
  const reversed = byPair.get('d->c');
  assert.ok(reversed);
  assert.deepEqual(reversed!.markerEnd, { type: 'arrowclosed' });
  assert.equal(reversed!.markerStart, undefined);

  const bidi = byPair.get('e->f');
  assert.ok(bidi);
  assert.deepEqual(bidi!.markerStart, { type: 'arrowclosed' });
  assert.deepEqual(bidi!.markerEnd, { type: 'arrowclosed' });
});

test('a plain "--" edge with no markers gets no marker at all', () => {
  const source = `architecture-beta
service a(logos:aws)["A"]
service b(logos:aws)["B"]
a:R -- L:b`;
  const graph = architectureToDesignGraph(parseArchitectureDiagram(source));
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].markerStart, undefined);
  assert.equal(graph.edges[0].markerEnd, undefined);
});

test('{group} suffix remaps an endpoint to its parent group', () => {
  const source = `architecture-beta
group g(logos:aws)["G"]
service inside(logos:aws)["Inside"] in g
service outside(logos:aws)["Outside"]
outside:R --> L:inside{group}`;
  const parse = parseArchitectureDiagram(source);
  assert.deepEqual(parse.issues, []);
  assert.equal(parse.edges.length, 1);
  assert.equal(parse.edges[0].targetId, 'g');
});

test('{group} suffix drops the edge if it collapses to a self-loop', () => {
  const source = `architecture-beta
group g(logos:aws)["G"]
service inside(logos:aws)["Inside"] in g
inside{group}:R --> L:inside{group}`;
  const parse = parseArchitectureDiagram(source);
  assert.equal(parse.edges.length, 0);
  assert.equal(parse.issues.length, 1);
  assert.match(parse.issues[0].message, /self-loop/);
});

test('align and title/accTitle/accDescr are accepted silently and ignored', () => {
  const source = `architecture-beta
title My Diagram
accTitle: An accessible title
accDescr: A longer description
service a(logos:aws)["A"]
service b(logos:aws)["B"]
align row a b`;
  const parse = parseArchitectureDiagram(source);
  assert.deepEqual(parse.issues, []);
  assert.equal(parse.groups.length + parse.services.length + parse.junctions.length, 2);
});

test('service x "DB" (text-glyph STRING pseudo-icon) is accepted with no icon key', () => {
  const source = `architecture-beta
service x "DB"["Database"]`;
  const parse = parseArchitectureDiagram(source);
  assert.deepEqual(parse.issues, []);
  assert.equal(parse.services[0].icon, undefined);
  assert.equal(parse.services[0].title, 'Database');
});

test('3-level nesting: group > group > service', () => {
  const source = `architecture-beta
group outer(logos:aws)["Outer"]
group inner(logos:aws)["Inner"] in outer
service leaf(logos:aws)["Leaf"] in inner`;
  const parse = parseArchitectureDiagram(source);
  assert.deepEqual(parse.issues, []);
  const graph = architectureToDesignGraph(parse);
  const leaf = graph.nodes.find((n) => n.id === 'leaf');
  const inner = graph.nodes.find((n) => n.id === 'inner');
  assert.equal(leaf?.parentId, 'inner');
  assert.equal(inner?.parentId, 'outer');
});

test('flowchart TD is not architecture-beta — exactly one issue, not one per line', () => {
  const parse = parseArchitectureDiagram('flowchart TD\n A --> B');
  assert.equal(parse.ok, false);
  assert.equal(parse.issues.length, 1);
});

test('empty string produces one issue and never throws', () => {
  assert.doesNotThrow(() => parseArchitectureDiagram(''));
  const parse = parseArchitectureDiagram('');
  assert.equal(parse.ok, false);
  assert.equal(parse.issues.length, 1);
});

test('garbage input never throws', () => {
  assert.doesNotThrow(() => parseArchitectureDiagram('architecture-beta\n$$$ ??? not a valid line ###'));
  const parse = parseArchitectureDiagram('architecture-beta\n$$$ ??? not a valid line ###');
  assert.equal(parse.ok, true);
  assert.equal(parse.issues.length, 1);
  assert.match(parse.issues[0].message, /unrecognized/);
});

test('dangling "in <group>" reference drops the parent and reports one issue', () => {
  const source = `architecture-beta
service a(logos:aws)["A"] in nosuchgroup`;
  const parse = parseArchitectureDiagram(source);
  assert.equal(parse.issues.length, 1);
  assert.equal(parse.services[0].parentIdRaw, undefined);
});

test('isArchitectureSource is true for architecture-beta, even behind a comment/blank line', () => {
  assert.equal(isArchitectureSource('architecture-beta\nservice a(logos:aws)["A"]'), true);
  assert.equal(isArchitectureSource('\n%% a comment\narchitecture-beta\nservice a(logos:aws)["A"]'), true);
});

test('isArchitectureSource is false for other mermaid diagram types', () => {
  assert.equal(isArchitectureSource('flowchart TD\n A --> B'), false);
  assert.equal(isArchitectureSource(''), false);
});

test('edge referencing an unknown id drops the edge and reports one issue', () => {
  const source = `architecture-beta
service a(logos:aws)["A"]
a:R --> L:nosuchid`;
  const parse = parseArchitectureDiagram(source);
  assert.equal(parse.edges.length, 0);
  assert.equal(parse.issues.length, 1);
});
