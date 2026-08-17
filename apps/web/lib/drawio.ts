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

const AWS4_RESOURCE_COLORS: Record<string, string> = {
  appsync: '#E7157B',
  athena: '#8C4FFF',
  aurora: '#C925D1',
  cognito: '#DD344C',
  dynamodb: '#C925D1',
  eventbridge: '#E7157B',
  lambda: '#ED7100',
  pinpoint: '#3334B9',
  s3: '#7AA116',
  sagemaker: '#01A88D',
  sagemaker_2: '#01A88D',
  step_functions: '#E7157B',
  timestream: '#C925D1',
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

    const color = AWS4_RESOURCE_COLORS[icon]
      ?? (icon.startsWith('iot_') ? '#7AA116' : undefined)
      ?? (icon.startsWith('kinesis_') ? '#8C4FFF' : undefined)
      ?? '#232F3E';

    return `style="${style}fillColor=${color};"`;
  });
}

export function normalizeDrawioSource(source: string, kind = ''): string {
  return isDrawioSource(source) ? normalizeAws4ResourceIcons(source) : drawioStarterSource(kind);
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
