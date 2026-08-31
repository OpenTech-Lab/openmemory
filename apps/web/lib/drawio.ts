export const DRAWIO_EDITOR_URL =
  process.env.NEXT_PUBLIC_DRAWIO_EDITOR_URL?.replace(/\/$/, '') ?? 'http://localhost:18081';

export const DRAWIO_VIEWER_URL =
  process.env.NEXT_PUBLIC_DRAWIO_VIEWER_URL?.replace(/\/$/, '') ?? 'http://localhost:18081';

export const DRAWIO_LIBRARIES = ['general', 'aws4', 'bpmn', 'flowchart', 'uml'];

const GRAPH_MODEL = `<mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
  </root>
</mxGraphModel>`;

export const DRAWIO_BLANK_SOURCE = `<mxfile host="OpenMemory" compressed="false">
  <diagram id="openmemory-page-1" name="Page-1">
    ${GRAPH_MODEL}
  </diagram>
</mxfile>`;

// A useful first canvas instead of an empty white page. It deliberately uses draw.io's native
// AWS4 stencil styles: the same XML is loaded by the editor and viewer, so no OpenMemory-side
// approximation or conversion exists between the two surfaces.
export const DRAWIO_AWS_STARTER_SOURCE = `<mxfile host="OpenMemory" compressed="false">
  <diagram id="openmemory-aws-starter" name="Architecture">
    <mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="cloud" value="AWS Cloud" style="shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud;verticalAlign=top;align=left;grIconSize=40;spacingLeft=45;spacingTop=5;fillColor=none;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;" vertex="1" parent="1">
          <mxGeometry x="170" y="100" width="760" height="430" as="geometry" />
        </mxCell>
        <mxCell id="vpc" value="VPC" style="shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;verticalAlign=top;align=left;grIconSize=40;spacingLeft=45;spacingTop=5;fontColor=#2C8723;fillColor=none;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;" vertex="1" parent="cloud">
          <mxGeometry x="155" y="85" width="540" height="265" as="geometry" />
        </mxCell>
        <mxCell id="api" value="Amazon API Gateway" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.api_gateway;verticalLabelPosition=bottom;align=center;verticalAlign=top;strokeColor=#ffffff;pointerEvents=1;" vertex="1" parent="vpc">
          <mxGeometry x="65" y="105" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="lambda" value="AWS Lambda" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;verticalLabelPosition=bottom;align=center;verticalAlign=top;strokeColor=#ffffff;pointerEvents=1;" vertex="1" parent="vpc">
          <mxGeometry x="235" y="105" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="database" value="Amazon DynamoDB" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.dynamodb;verticalLabelPosition=bottom;align=center;verticalAlign=top;strokeColor=#ffffff;pointerEvents=1;" vertex="1" parent="vpc">
          <mxGeometry x="405" y="105" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="bucket" value="Amazon S3" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;verticalLabelPosition=bottom;align=center;verticalAlign=top;strokeColor=#ffffff;pointerEvents=1;" vertex="1" parent="cloud">
          <mxGeometry x="725" y="185" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="edge-api-lambda" value="request" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;" edge="1" parent="vpc" source="api" target="lambda">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="edge-lambda-db" value="read / write" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;" edge="1" parent="vpc" source="lambda" target="database">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
        <mxCell id="edge-lambda-s3" value="objects" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;" edge="1" parent="cloud" source="lambda" target="bucket">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

export function drawioStarterSource(kind: string): string {
  return kind === 'aws' || kind === 'deployment' ? DRAWIO_AWS_STARTER_SOURCE : DRAWIO_BLANK_SOURCE;
}

export function isDrawioStarterSource(source: string): boolean {
  return source === DRAWIO_BLANK_SOURCE || source === DRAWIO_AWS_STARTER_SOURCE;
}

export function isDrawioSource(source: string): boolean {
  const trimmed = source.trim();
  return /^<mxfile(?:\s|>)/.test(trimmed) || /^<mxGraphModel(?:\s|>)/.test(trimmed);
}

// Generated by scripts/gen-aws4-colors.mjs from draw.io's AWS4 sidebar definitions
// (Sidebar-AWS4.js). Do not hand-edit — re-run the script to regenerate after draw.io's
// AWS4 stencil colours change upstream.
const AWS4_RESOURCE_COLORS: Record<string, string> = {
  activate: '#C925D1',
  alexa_for_business: '#DD344C',
  all_products: '#1E262E',
  amplify: '#DD344C',
  analytics: '#8C4FFF',
  apache_mxnet_on_aws: '#01A88D',
  api_gateway: '#8C4FFF',
  app_config: '#E7157B',
  app_mesh: '#8C4FFF',
  app_runner: '#ED7100',
  app_studio: '#01A88D',
  app_wizard: '#E7157B',
  appfabric: '#DD344C',
  appflow: '#E7157B',
  application_auto_scaling: '#E7157B',
  application_composer: '#C925D1',
  application_cost_profiler: '#7AA116',
  application_discovery_service: '#01A88D',
  application_integration: '#E7157B',
  application_recovery_controller: '#8C4FFF',
  appstream_20: '#01A88D',
  appsync: '#E7157B',
  ar_vr: '#BC1356',
  artifact: '#DD344C',
  athena: '#8C4FFF',
  audit_manager: '#DD344C',
  augmented_ai: '#01A88D',
  aurora: '#C925D1',
  auto_scaling2: '#ED7100',
  auto_scaling3: '#ED7100',
  autoscaling: '#E7157B',
  b2b_data_interchange: '#E7157B',
  backint_agent: '#E7157B',
  backup: '#7AA116',
  batch: '#ED7100',
  bedrock: '#01A88D',
  bedrock_agentcore: '#01A88D',
  blockchain: '#ED7100',
  bottlerocket: '#ED7100',
  braket: '#ED7100',
  budgets_2: '#7AA116',
  business_application: '#DD344C',
  certificate_manager_3: '#DD344C',
  chatbot: '#E7157B',
  chime: '#DD344C',
  chime_sdk: '#DD344C',
  clean_rooms: '#8C4FFF',
  client_vpn: '#8C4FFF',
  cloud9: '#C925D1',
  cloud_control_api: '#C925D1',
  cloud_development_kit: '#C925D1',
  cloud_directory: '#DD344C',
  cloud_map: '#8C4FFF',
  cloud_wan: '#8C4FFF',
  cloudendure_disaster_recovery: '#7AA116',
  cloudendure_migration: '#01A88D',
  cloudformation: '#E7157B',
  cloudfront: '#8C4FFF',
  cloudhsm: '#DD344C',
  cloudsearch2: '#8C4FFF',
  cloudshell: '#C925D1',
  cloudtrail: '#E7157B',
  cloudwatch_2: '#E7157B',
  codeartifact: '#C925D1',
  codebuild: '#C925D1',
  codecatalyst: '#C925D1',
  codecommit: '#C925D1',
  codedeploy: '#C925D1',
  codeguru: '#E7157B',
  codeguru_2: '#01A88D',
  codepipeline: '#C925D1',
  codestar: '#C925D1',
  codewhisperer: '#01A88D',
  cognito: '#DD344C',
  command_line_interface: '#E7157B',
  comprehend: '#01A88D',
  comprehend_medical: '#01A88D',
  compute: '#ED7100',
  compute_optimizer: '#E7157B',
  config: '#E7157B',
  connect: '#3334B9',
  contact_center: '#DD344C',
  containers: '#ED7100',
  control_tower: '#E7157B',
  corretto: '#C925D1',
  cost_and_usage_report: '#7AA116',
  cost_explorer: '#7AA116',
  cost_management: '#7AA116',
  custom_billing_manager: '#7AA116',
  customer_enablement: '#C925D1',
  customer_engagement: '#3334B9',
  data_exchange: '#8C4FFF',
  data_pipeline: '#8C4FFF',
  data_transfer_terminal: '#01A88D',
  database: '#C925D1',
  database_migration_service: '#01A88D',
  datasync: '#01A88D',
  datazone: '#8C4FFF',
  deadline_cloud: '#ED7100',
  deep_learning_amis: '#01A88D',
  deep_learning_containers: '#01A88D',
  deepcomposer: '#01A88D',
  deeplens: '#01A88D',
  deepracer: '#01A88D',
  desktop_and_app_streaming: '#01A88D',
  detective: '#DD344C',
  developer_tools: '#C925D1',
  device_farm: '#DD344C',
  devops_agent: '#E7157B',
  devops_guru: '#01A88D',
  direct_connect: '#8C4FFF',
  directory_service: '#DD344C',
  distro_for_opentelemetry: '#E7157B',
  documentdb_with_mongodb_compatibility: '#C925D1',
  dynamodb: '#C925D1',
  ec2: '#ED7100',
  ec2_image_builder: '#ED7100',
  ecr: '#ED7100',
  ecs: '#ED7100',
  ecs_anywhere: '#ED7100',
  efs_infrequentaccess: '#7AA116',
  efs_standard: '#7AA116',
  eks: '#ED7100',
  eks_anywhere: '#ED7100',
  eks_cloud: '#ED7100',
  eks_distro: '#ED7100',
  elastic_beanstalk: '#ED7100',
  elastic_block_store: '#7AA116',
  elastic_fabric_adapter: '#ED7100',
  elastic_file_system: '#7AA116',
  elastic_inference_2: '#01A88D',
  elastic_load_balancing: '#8C4FFF',
  elastic_transcoder: '#ED7100',
  elastic_vmware_service: '#01A88D',
  elasticache: '#C925D1',
  elasticsearch_service: '#8C4FFF',
  elemental: '#ED7100',
  elemental_link: '#ED7100',
  elemental_mediaconnect: '#ED7100',
  elemental_mediaconvert: '#ED7100',
  elemental_medialive: '#ED7100',
  elemental_mediapackage: '#ED7100',
  elemental_mediastore: '#ED7100',
  elemental_mediatailor: '#ED7100',
  emr: '#8C4FFF',
  end_user_messaging: '#DD344C',
  entity_resolution: '#8C4FFF',
  eventbridge: '#E7157B',
  express_workflow: '#E7157B',
  fargate: '#ED7100',
  fault_injection_simulator: '#E7157B',
  file_cache: '#7AA116',
  finspace: '#8C4FFF',
  firewall_manager: '#DD344C',
  forecast: '#01A88D',
  fraud_detector: '#01A88D',
  freertos: '#7AA116',
  fsx: '#7AA116',
  fsx_for_lustre: '#7AA116',
  fsx_for_netapp_ontap: '#7AA116',
  fsx_for_openzfs: '#7AA116',
  fsx_for_windows_file_server: '#7AA116',
  gamekit: '#8C4FFF',
  gamelift_2: '#8C4FFF',
  gamelift_streams: '#8C4FFF',
  games: '#8C4FFF',
  gamesparks: '#8C4FFF',
  general: '#1E262E',
  genomics_cli: '#ED7100',
  glacier: '#7AA116',
  global_accelerator: '#8C4FFF',
  glue: '#8C4FFF',
  glue_databrew: '#8C4FFF',
  glue_elastic_views: '#8C4FFF',
  greengrass: '#7AA116',
  ground_station: '#C925D1',
  guardduty: '#DD344C',
  healthimaging: '#01A88D',
  healthlake: '#01A88D',
  healthscribe: '#01A88D',
  honeycode: '#DD344C',
  identity_and_access_management: '#DD344C',
  infrequent_access_storage_class: '#7AA116',
  inspector: '#DD344C',
  interactive_video: '#ED7100',
  internet_of_things: '#7AA116',
  iot_1click: '#7AA116',
  iot_analytics: '#7AA116',
  iot_button: '#7AA116',
  iot_core: '#7AA116',
  iot_device_defender: '#7AA116',
  iot_device_management: '#7AA116',
  iot_edukit: '#7AA116',
  iot_events: '#7AA116',
  iot_expresslink: '#7AA116',
  iot_fleetwise: '#7AA116',
  iot_roborunner: '#7AA116',
  iot_sitewise: '#7AA116',
  iot_things_graph: '#7AA116',
  iot_twinmaker: '#7AA116',
  iq: '#C925D1',
  kendra: '#01A88D',
  key_management_service: '#DD344C',
  keyspaces: '#C925D1',
  kinesis: '#8C4FFF',
  kinesis_data_analytics: '#8C4FFF',
  kinesis_data_firehose: '#8C4FFF',
  kinesis_data_streams: '#8C4FFF',
  kinesis_video_streams: '#ED7100',
  lake_formation: '#8C4FFF',
  lambda: '#ED7100',
  lex: '#01A88D',
  license_manager: '#E7157B',
  lightsail: '#ED7100',
  lightsail_for_research: '#ED7100',
  local_zones: '#ED7100',
  location_service: '#DD344C',
  lookout_for_equipment: '#01A88D',
  lookout_for_metrics: '#01A88D',
  lookout_for_vision: '#01A88D',
  lumberyard: '#8C4FFF',
  machine_learning: '#01A88D',
  macie: '#DD344C',
  mainframe_modernization: '#01A88D',
  managed_apache_cassandra_service: '#C925D1',
  managed_blockchain: '#ED7100',
  managed_service_for_apache_flink: '#8C4FFF',
  managed_service_for_grafana: '#E7157B',
  managed_service_for_prometheus: '#E7157B',
  managed_services: '#E7157B',
  managed_streaming_for_kafka: '#8C4FFF',
  managed_workflows_for_apache_airflow: '#E7157B',
  management_and_governance: '#E7157B',
  management_console: '#E7157B',
  marketplace: '#1E262E',
  media_services: '#ED7100',
  memorydb_for_redis: '#C925D1',
  migration_and_transfer: '#01A88D',
  migration_evaluator: '#01A88D',
  migration_hub: '#01A88D',
  mobile: '#DD344C',
  mobile_application: '#E7157B',
  monitron: '#01A88D',
  mq: '#E7157B',
  neptune: '#C925D1',
  network_firewall: '#DD344C',
  networking_and_content_delivery: '#8C4FFF',
  neuron_ml_sdk: '#01A88D',
  nice_dcv: '#ED7100',
  nice_enginframe: '#ED7100',
  nimble_studio: '#ED7100',
  nitro_enclaves: '#ED7100',
  nova2: '#01A88D',
  omics: '#01A88D',
  open_3d_engine_2: '#8C4FFF',
  opsworks: '#E7157B',
  oracle_database_at_aws: '#C925D1',
  organizations: '#DD344C',
  outposts: '#ED7100',
  outposts_1u_and_2u_servers: '#ED7100',
  outposts_family: '#ED7100',
  panorama: '#01A88D',
  parallel_cluster: '#ED7100',
  parallel_computing_service: '#ED7100',
  partner_central: '#E7157B',
  payment_cryptography: '#DD344C',
  personal_health_dashboard: '#E7157B',
  personalize: '#01A88D',
  pinpoint: '#3334B9',
  polly: '#01A88D',
  private_5g: '#8C4FFF',
  private_certificate_authority: '#DD344C',
  professional_services: '#C925D1',
  proton: '#E7157B',
  q: '#01A88D',
  quantum_ledger_database: '#C925D1',
  quantum_technologies: '#ED7100',
  quick_suite: '#DD344C',
  quicksight: '#8C4FFF',
  rds: '#C925D1',
  rds_on_vmware: '#C925D1',
  red_hat_openshift: '#ED7100',
  redshift: '#C925D1',
  rekognition_2: '#01A88D',
  repost: '#C925D1',
  repost_private: '#C925D1',
  reserved_instance_reporting: '#7AA116',
  resilience_hub: '#E7157B',
  resource_access_manager: '#DD344C',
  resource_explorer: '#E7157B',
  robomaker: '#DD344C',
  robotics: '#DD344C',
  route_53: '#8C4FFF',
  rtb_fabric: '#8C4FFF',
  s3: '#7AA116',
  s3_on_outposts_storage: '#7AA116',
  sagemaker: '#01A88D',
  sagemaker_2: '#8C4FFF',
  sagemaker_ground_truth: '#01A88D',
  sagemaker_studio_lab: '#01A88D',
  satellite: '#C925D1',
  savings_plans: '#7AA116',
  secrets_manager: '#DD344C',
  security_agent: '#DD344C',
  security_hub: '#DD344C',
  security_identity_and_compliance: '#DD344C',
  security_incident_response: '#DD344C',
  security_lake: '#DD344C',
  server_migration_service: '#01A88D',
  serverless: '#8C4FFF',
  serverless_application_repository: '#ED7100',
  service_catalog: '#E7157B',
  service_management_connector: '#E7157B',
  shield: '#DD344C',
  signer: '#DD344C',
  simple_email_service: '#3334B9',
  simspace_weaver: '#ED7100',
  single_sign_on: '#DD344C',
  site_to_site_vpn: '#8C4FFF',
  snowball: '#7AA116',
  snowball_edge: '#7AA116',
  snowcone: '#7AA116',
  snowmobile: '#7AA116',
  sns: '#E7157B',
  sql_workbench: '#8C4FFF',
  sqs: '#E7157B',
  step_functions: '#E7157B',
  storage: '#7AA116',
  storage_gateway: '#7AA116',
  sumerian: '#BC1356',
  supply_chain: '#DD344C',
  support: '#C925D1',
  systems_manager: '#E7157B',
  systems_manager_incident_manager: '#E7157B',
  telco_network_builder: '#E7157B',
  tensorflow_on_aws: '#01A88D',
  textract: '#01A88D',
  thinkbox_deadline: '#ED7100',
  thinkbox_draft: '#ED7100',
  thinkbox_frost: '#ED7100',
  thinkbox_krakatoa: '#ED7100',
  thinkbox_sequoia: '#ED7100',
  thinkbox_stoke: '#ED7100',
  thinkbox_xmesh: '#ED7100',
  timestream: '#C925D1',
  tools_and_sdks: '#C925D1',
  torchserve: '#01A88D',
  training_certification: '#C925D1',
  transcribe: '#01A88D',
  transfer_family: '#01A88D',
  transfer_for_sftp: '#01A88D',
  transform: '#01A88D',
  transit_gateway: '#8C4FFF',
  translate: '#01A88D',
  trusted_advisor: '#E7157B',
  user_notifications: '#E7157B',
  verified_access: '#8C4FFF',
  verified_permissions: '#DD344C',
  vmware_cloud_on_aws: '#ED7100',
  vpc: '#8C4FFF',
  vpc_lattice: '#8C4FFF',
  vpc_privatelink: '#8C4FFF',
  waf: '#DD344C',
  wavelength: '#ED7100',
  well_architect_tool: '#E7157B',
  wickr: '#DD344C',
  workdocs: '#01A88D',
  worklink: '#01A88D',
  workmail: '#DD344C',
  workspaces: '#01A88D',
  workspaces_family: '#01A88D',
  workspaces_thin_client: '#01A88D',
  xray: '#C925D1',
};

/**
 * Older/imported AWS4 resource icons can contain a white stencil foreground without the
 * category-coloured background expected by mxAWS4.js. Draw.io then faithfully paints a
 * white icon on a white square. Supply only the missing background, preserving authored
 * colours and the persisted XML itself.
 */
export function normalizeAws4ResourceIcons(source: string): string {
  return source.replace(/style="([^"]*shape=mxgraph\.aws4\.resourceIcon;[^"]*)"/g, (attribute, style: string) => {
    if (/(?:^|;)fillColor=/.test(style)) return attribute;

    const icon = /(?:^|;)resIcon=mxgraph\.aws4\.([^;]+)/.exec(style)?.[1];
    if (!icon) return attribute;

    const color = AWS4_RESOURCE_COLORS[icon] ?? '#232F3E';

    return `style="${style}fillColor=${color};"`;
  });
}

interface PaintCell {
  /** Whitespace that preceded this element, kept so the rewrite reuses the document's own indent. */
  leading: string;
  text: string;
  id?: string;
  parent?: string;
  isEdge: boolean;
  isVertex: boolean;
  style: string;
  value: string;
  source?: string;
  target?: string;
  geometry?: { x?: number; y?: number; width?: number; height?: number };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

function cellAttribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

function numericAttribute(attributes: string, name: string): number | undefined {
  const raw = cellAttribute(attributes, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** One `key=value` token out of draw.io's `;`-delimited style micro-format. */
function styleToken(style: string, key: string): string | undefined {
  return new RegExp(`(?:^|;)${key}=([^;]*)`).exec(style)?.[1];
}

/** Splits one `<root>` body into its child elements. A cell carrying custom attributes is wrapped
 * in `<object>`/`<UserObject>`, which holds the `id` while the inner `<mxCell>` holds
 * `parent`/`edge` — so the two are read from different tags. Cells never nest (mxGraphModel keeps
 * them flat under `<root>`, hierarchy lives in the `parent` attribute), so one linear scan does it. */
function scanPaintCells(inner: string): { cells: PaintCell[]; tail: string } {
  const cells: PaintCell[] = [];
  const openRe = /(\s*)<(mxCell|object|UserObject)\b([^>]*?)(\/?)>/g;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = openRe.exec(inner))) {
    const [, leading, tag, attributes, selfClosing] = match;
    if (selfClosing !== '/') {
      const closeIndex = inner.indexOf(`</${tag}>`, openRe.lastIndex);
      openRe.lastIndex = closeIndex === -1 ? inner.length : closeIndex + `</${tag}>`.length;
    }
    end = openRe.lastIndex;
    const text = inner.slice(match.index + leading.length, end);
    const mxCellAttributes = /<mxCell\b([^>]*?)\/?>/.exec(text)?.[1] ?? attributes;
    const geometryAttributes = /<mxGeometry\b([^>]*?)\/?>/.exec(text)?.[1];
    cells.push({
      leading,
      text,
      id: cellAttribute(attributes, 'id') ?? cellAttribute(mxCellAttributes, 'id'),
      parent: cellAttribute(mxCellAttributes, 'parent'),
      isEdge: cellAttribute(mxCellAttributes, 'edge') === '1',
      isVertex: cellAttribute(mxCellAttributes, 'vertex') === '1',
      style: cellAttribute(mxCellAttributes, 'style') ?? '',
      value: cellAttribute(mxCellAttributes, 'value') ?? cellAttribute(attributes, 'label') ?? '',
      source: cellAttribute(mxCellAttributes, 'source'),
      target: cellAttribute(mxCellAttributes, 'target'),
      geometry: geometryAttributes === undefined ? undefined : {
        x: numericAttribute(geometryAttributes, 'x'),
        y: numericAttribute(geometryAttributes, 'y'),
        width: numericAttribute(geometryAttributes, 'width'),
        height: numericAttribute(geometryAttributes, 'height'),
      },
    });
  }
  return { cells, tail: inner.slice(end) };
}

/** Depth-first from the model root, emitting each parent's edges before its vertices. Walking the
 * tree (rather than sorting the flat list) is what keeps every cell declared after its own parent,
 * which mxCodec needs to resolve `parent` by id. */
function orderPaintCells(cells: PaintCell[]): PaintCell[] {
  const byParent = new Map<string | undefined, PaintCell[]>();
  for (const cell of cells) {
    const siblings = byParent.get(cell.parent);
    if (siblings) siblings.push(cell);
    else byParent.set(cell.parent, [cell]);
  }

  const ordered: PaintCell[] = [];
  const emitted = new Set<PaintCell>();
  const walk = (parent: string | undefined) => {
    const siblings = byParent.get(parent) ?? [];
    for (const cell of [...siblings.filter((s) => s.isEdge), ...siblings.filter((s) => !s.isEdge)]) {
      if (emitted.has(cell)) continue;
      emitted.add(cell);
      ordered.push(cell);
      if (cell.id !== undefined) walk(cell.id);
    }
  };
  walk(undefined); // the model root `<mxCell id="0" />` is the only cell with no `parent`

  // An orphan (its `parent` names a cell that isn't in the document) is unreachable from the root.
  // Keep it rather than dropping it — a rewrite that silently loses cells is worse than a stray one.
  for (const cell of cells) if (!emitted.has(cell)) ordered.push(cell);
  return ordered;
}

/**
 * draw.io has no z-index: within one parent, cells paint in document order, so whatever is declared
 * last paints on top. draw.io appends each newly drawn edge to the end of the model, which is why a
 * saved AWS diagram reliably ends up with connector lines struck straight across the resource icons
 * they connect. Re-emit every parent's edges first and its vertices last so the icons paint over the
 * lines.
 *
 * Deliberately scoped to sources that actually use AWS4 stencils. Applied to the swimlane and
 * sequence diagrams under docs/refer/draw/workflow/, the same rewrite would push a cross-lane arrow
 * behind the opaque lane fill it crosses — trading one invisible-line bug for another.
 *
 * Note this also puts *edge labels* behind icons, since a label belongs to its edge. Where a label
 * sits directly on top of an icon it gets clipped; that is a crowded-layout problem to solve by
 * moving the label, not by putting the whole line back on top of the icon.
 */
export function normalizeAws4PaintOrder(source: string): string {
  if (!source.includes('shape=mxgraph.aws4.')) return source;

  return source.replace(/(<root\b[^>]*>)([\s\S]*?)(<\/root>)/g, (block, open: string, inner: string, close: string) => {
    const { cells, tail } = scanPaintCells(inner);
    if (cells.length === 0) return block;

    const ordered = orderPaintCells(cells);
    return open + ordered.map((cell, index) => cells[index].leading + cell.text).join('') + tail + close;
  });
}

/** Where a label may sit along its edge: the midpoint first (draw.io's own default), then further
 * out towards each end. `-1` is the source end, `1` the target end. */
const LABEL_POSITIONS = [0, -0.5, 0.5, -0.75, 0.75];

/** Label text as it is measured on screen: entities decoded, `<br>`/`<div>` treated as line breaks
 * and the remaining markup dropped (draw.io renders `value` as HTML whenever the style has html=1). */
function plainLabel(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/<br\s*\/?>|<\/div>|<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .trim();
}

/** Absolute rect per vertex id. A child's geometry is relative to its parent's origin, so the
 * parent chain has to be resolved before any two shapes can be compared. */
function absoluteVertexRects(cells: PaintCell[]): Map<string, Rect> {
  const byId = new Map<string, PaintCell>();
  for (const cell of cells) if (cell.id !== undefined) byId.set(cell.id, cell);

  const rects = new Map<string, Rect>();
  const resolve = (id: string, visiting: Set<string>): Rect | undefined => {
    const cached = rects.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return undefined; // a parent cycle can only come from corrupt XML
    visiting.add(id);

    const cell = byId.get(id);
    const geometry = cell?.geometry;
    if (!cell?.isVertex || geometry?.x === undefined || geometry.y === undefined
      || geometry.width === undefined || geometry.height === undefined) return undefined;

    const origin = cell.parent === undefined ? undefined : resolve(cell.parent, visiting);
    const rect = {
      x: (origin?.x ?? 0) + geometry.x,
      y: (origin?.y ?? 0) + geometry.y,
      width: geometry.width,
      height: geometry.height,
    };
    rects.set(id, rect);
    return rect;
  };

  for (const id of byId.keys()) resolve(id, new Set());
  return rects;
}

/** Approximates the path draw.io's orthogonal router draws between two shapes: a straight run when
 * the shapes share a band on one axis, otherwise a single-elbow L leaving along the longer axis.
 * Close enough to tell whether a label lands on an icon — edges with hand-placed waypoints are
 * skipped by the caller rather than guessed at. */
function routeBetween(source: Rect, target: Rect): Point[] {
  const bandTop = Math.max(source.y, target.y);
  const bandBottom = Math.min(source.y + source.height, target.y + target.height);
  const bandLeft = Math.max(source.x, target.x);
  const bandRight = Math.min(source.x + source.width, target.x + target.width);
  const apart = (a: Rect, b: Rect, axis: 'x' | 'y', size: 'width' | 'height') =>
    a[axis] + a[size] <= b[axis] || b[axis] + b[size] <= a[axis];

  if (bandBottom > bandTop && apart(source, target, 'x', 'width')) {
    const y = (bandTop + bandBottom) / 2;
    return source.x < target.x
      ? [{ x: source.x + source.width, y }, { x: target.x, y }]
      : [{ x: source.x, y }, { x: target.x + target.width, y }];
  }

  if (bandRight > bandLeft && apart(source, target, 'y', 'height')) {
    const x = (bandLeft + bandRight) / 2;
    return source.y < target.y
      ? [{ x, y: source.y + source.height }, { x, y: target.y }]
      : [{ x, y: source.y }, { x, y: target.y + target.height }];
  }

  const from = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  if (Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)) {
    return [
      { x: to.x > from.x ? source.x + source.width : source.x, y: from.y },
      { x: to.x, y: from.y },
      { x: to.x, y: to.y > from.y ? target.y : target.y + target.height },
    ];
  }
  return [
    { x: from.x, y: to.y > from.y ? source.y + source.height : source.y },
    { x: from.x, y: to.y },
    { x: to.x > from.x ? target.x : target.x + target.width, y: to.y },
  ];
}

/** The point at `position` along the path, using mxGraph's -1..1 convention for edge labels. */
function pointAlong(path: Point[], position: number): Point {
  const spans = path.slice(1).map((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y));
  const total = spans.reduce((sum, span) => sum + span, 0);
  if (total === 0) return path[0];

  let remaining = Math.min(1, Math.max(0, (position + 1) / 2)) * total;
  for (const [index, span] of spans.entries()) {
    if (remaining <= span) {
      const ratio = span === 0 ? 0 : remaining / span;
      return {
        x: path[index].x + (path[index + 1].x - path[index].x) * ratio,
        y: path[index].y + (path[index + 1].y - path[index].y) * ratio,
      };
    }
    remaining -= span;
  }
  return path[path.length - 1];
}

/** draw.io centres an edge label on its anchor. Width is estimated from the font size rather than
 * measured — there is no text metric under Node, and erring wide only makes placement warier. */
function labelBox(value: string, style: string, anchor: Point): Rect {
  const fontSize = Number(styleToken(style, 'fontSize')) || 12;
  const lines = plainLabel(value).split('\n');
  const width = Math.max(...lines.map((line) => line.length)) * fontSize * 0.55 + 8;
  const height = lines.length * (fontSize + 5);
  return { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function withLabelPosition(text: string, position: number): string {
  return text.replace(/<mxGeometry\b([^>]*?)(\/?)>/, (_match, attributes: string, selfClosing: string) =>
    `<mxGeometry ${attributes.trim()} x="${position}"${selfClosing === '/' ? ' /' : ''}>`);
}

/**
 * Companion to `normalizeAws4PaintOrder`. Once connector lines sit behind the icons, so do their
 * labels — a label belongs to its edge's state, and nothing in mxGraph separates the two: an
 * `edgeLabel` child cell paints inside the edge's own subtree, and `labelBackgroundColor` is drawn
 * under an opaque icon just the same (both verified against the bundled draw.io). The only fix left
 * is positional, so slide a label that lands on an icon further along its edge until it clears.
 *
 * Only labels draw.io placed by default are moved: an edge whose geometry already carries an `x` or
 * an `<mxPoint as="offset">` was positioned by a person and is left exactly where they put it, and
 * an edge with hand-placed waypoints is skipped because its real path is not the estimated one.
 * Labels are resolved in document order against the icons *and* against labels already placed, so
 * the pass cannot solve one collision by creating another.
 */
export function normalizeAws4LabelPlacement(source: string): string {
  if (!source.includes('shape=mxgraph.aws4.')) return source;

  return source.replace(/(<root\b[^>]*>)([\s\S]*?)(<\/root>)/g, (block, open: string, inner: string, close: string) => {
    const { cells, tail } = scanPaintCells(inner);
    if (cells.length === 0) return block;

    const rects = absoluteVertexRects(cells);
    const edgeIds = new Set(cells.filter((cell) => cell.isEdge).map((cell) => cell.id));
    const obstacles = cells
      .filter((cell) => cell.isVertex
        && !edgeIds.has(cell.parent) // an edgeLabel child cell is text, not something that hides text
        && styleToken(cell.style, 'container') !== '1'
        && styleToken(cell.style, 'fillColor') !== 'none')
      .map((cell) => (cell.id === undefined ? undefined : rects.get(cell.id)))
      .filter((rect): rect is Rect => rect !== undefined);

    const placed: Rect[] = [];
    let changed = false;

    for (const cell of cells) {
      if (!cell.isEdge || plainLabel(cell.value) === '') continue;
      if (!/<mxGeometry\b[^>]*\brelative="1"/.test(cell.text)) continue;
      if (/<Array\b[^>]*as="points"/.test(cell.text)) continue; // hand-routed: path unknown

      const source = cell.source === undefined ? undefined : rects.get(cell.source);
      const target = cell.target === undefined ? undefined : rects.get(cell.target);
      if (!source || !target) continue;

      const path = routeBetween(source, target);
      const authored = /<mxGeometry\b[^>]*\bx="/.test(cell.text) || /<mxPoint\b[^>]*as="offset"/.test(cell.text);
      if (authored) {
        const position = numericAttribute(/<mxGeometry\b([^>]*?)\/?>/.exec(cell.text)?.[1] ?? '', 'x') ?? 0;
        placed.push(labelBox(cell.value, cell.style, pointAlong(path, position)));
        continue;
      }

      const boxes = LABEL_POSITIONS.map((position) => ({
        position,
        box: labelBox(cell.value, cell.style, pointAlong(path, position)),
      }));
      const clear = boxes.find(({ box }) =>
        !obstacles.some((obstacle) => overlaps(box, obstacle)) && !placed.some((other) => overlaps(box, other)));

      // Nowhere clear to put it: leave the author's diagram as it is rather than shuffling the label
      // somewhere equally covered.
      const chosen = clear ?? boxes[0];
      placed.push(chosen.box);
      if (chosen.position === 0) continue;

      cell.text = withLabelPosition(cell.text, chosen.position);
      changed = true;
    }

    if (!changed) return block;
    return open + cells.map((cell) => cell.leading + cell.text).join('') + tail + close;
  });
}

export function normalizeDrawioSource(source: string, kind = ''): string {
  return isDrawioSource(source)
    ? normalizeAws4LabelPlacement(normalizeAws4PaintOrder(normalizeAws4ResourceIcons(source)))
    : drawioStarterSource(kind);
}

export interface DrawioMessage {
  event?: string;
  xml?: string;
  data?: string;
  error?: string;
}

export function parseDrawioMessage(value: unknown): DrawioMessage | null {
  let parsed = value;
  if (typeof value === 'string') {
    if (value === 'ready') return { event: 'ready' };
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  return {
    event: typeof message.event === 'string' ? message.event : undefined,
    xml: typeof message.xml === 'string' ? message.xml : undefined,
    data: typeof message.data === 'string' ? message.data : undefined,
    error: typeof message.error === 'string' ? message.error : undefined,
  };
}

export function drawioEditorSrc(darkMode = false): string {
  const params = new URLSearchParams({
    embed: '1',
    proto: 'json',
    spin: '1',
    libraries: '1',
    libs: DRAWIO_LIBRARIES.join(';'),
    noSaveBtn: '1',
    saveAndExit: '0',
    noExitBtn: '1',
    ui: 'kennedy',
    dark: darkMode ? '1' : '0',
    offline: '1',
    stealth: '1',
  });
  return `${DRAWIO_EDITOR_URL}/?${params.toString()}`;
}

export function drawioViewerSrc(darkMode = false): string {
  const params = new URLSearchParams({
    client: '1',
    lightbox: '1',
    nav: '1',
    layers: '1',
    zoom: '1',
    libraries: '1',
    libs: DRAWIO_LIBRARIES.join(';'),
    offline: '1',
    stealth: '1',
    dark: darkMode ? '1' : '0',
  });
  return `${DRAWIO_VIEWER_URL}/?${params.toString()}`;
}
