import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DRAWIO_AWS_STARTER_SOURCE,
  DRAWIO_BLANK_SOURCE,
  drawioEditorSrc,
  drawioStarterSource,
  drawioViewerSrc,
  normalizeAws4LabelPlacement,
  normalizeAws4PaintOrder,
  normalizeAws4ResourceIcons,
  normalizeDrawioSource,
  isDrawioSource,
  parseDrawioMessage,
} from './drawio.ts';

test('adds the missing AWS4 resource background while preserving explicit colours', () => {
  const legacy = '<mxCell style="strokeColor=#ffffff;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;" />';
  assert.match(normalizeAws4ResourceIcons(legacy), /fillColor=#ED7100;/);

  const authored = '<mxCell style="fillColor=#123456;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.lambda;" />';
  assert.equal(normalizeAws4ResourceIcons(authored), authored);
});

test('resolves an icon outside the old 13-entry table via the full generated colour map', () => {
  const cell = '<mxCell style="strokeColor=#ffffff;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.api_gateway;" />';
  assert.match(normalizeAws4ResourceIcons(cell), /fillColor=#8C4FFF;/);
});

test('falls back to Squid Ink for an icon absent from the generated colour map', () => {
  const cell = '<mxCell style="strokeColor=#ffffff;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.not_a_real_icon;" />';
  assert.match(normalizeAws4ResourceIcons(cell), /fillColor=#232F3E;/);
});

test('starter sources are valid draw.io XML documents', () => {
  assert.equal(isDrawioSource(DRAWIO_BLANK_SOURCE), true);
  assert.equal(isDrawioSource(DRAWIO_AWS_STARTER_SOURCE), true);
  assert.equal(drawioStarterSource('aws'), DRAWIO_AWS_STARTER_SOURCE);
  assert.equal(drawioStarterSource('workflow'), DRAWIO_BLANK_SOURCE);
});

test('draw.io source detection rejects unrelated text', () => {
  assert.equal(isDrawioSource('flowchart LR\n  a --> b'), false);
  assert.equal(isDrawioSource('{"nodes":[]}'), false);
  assert.equal(isDrawioSource('<mxGraphModel><root /></mxGraphModel>'), true);
});

test('message parser accepts editor JSON and viewer ready events', () => {
  assert.deepEqual(parseDrawioMessage('ready'), { event: 'ready' });
  assert.deepEqual(parseDrawioMessage('{"event":"autosave","xml":"<mxfile />"}'), {
    event: 'autosave',
    xml: '<mxfile />',
    data: undefined,
    error: undefined,
  });
  assert.equal(parseDrawioMessage('not-json'), null);
});

test('embed URLs enable JSON autosave and read-only client protocols', () => {
  const editor = new URL(drawioEditorSrc());
  assert.equal(editor.searchParams.get('embed'), '1');
  assert.equal(editor.searchParams.get('proto'), 'json');
  assert.equal(editor.searchParams.get('libs')?.includes('aws4'), true);
  assert.equal(editor.searchParams.get('noSaveBtn'), '1');
  assert.equal(editor.searchParams.get('offline'), '1');
  assert.equal(editor.searchParams.get('stealth'), '1');
  assert.equal(editor.searchParams.get('dark'), '0');
  assert.equal(editor.origin, 'http://localhost:18081');

  const darkEditor = new URL(drawioEditorSrc(true));
  assert.equal(darkEditor.searchParams.get('dark'), '1');

  const viewer = new URL(drawioViewerSrc());
  assert.equal(viewer.searchParams.get('client'), '1');
  assert.equal(viewer.searchParams.get('lightbox'), '1');
  assert.equal(viewer.searchParams.get('nav'), '1');
  assert.equal(viewer.searchParams.get('libraries'), '1');
  assert.equal(viewer.searchParams.get('libs')?.includes('aws4'), true);
  assert.equal(viewer.searchParams.get('offline'), '1');
  assert.equal(viewer.searchParams.get('dark'), '0');
  assert.equal(viewer.origin, 'http://localhost:18081');

  const darkViewer = new URL(drawioViewerSrc(true));
  assert.equal(darkViewer.searchParams.get('dark'), '1');
});

const AWS_PAINT_ORDER_SOURCE = `<mxfile host="OpenMemory" compressed="false">
  <diagram id="d1" name="Page-1">
    <mxGraphModel dx="1422" dy="794">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="cloud" value="AWS Cloud" style="shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud;" vertex="1" parent="1">
          <mxGeometry x="80" y="80" width="900" height="470" as="geometry" />
        </mxCell>
        <mxCell id="svc" value="AWS Fargate" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.fargate;" vertex="1" parent="cloud">
          <mxGeometry x="270" y="120" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="db" value="Amazon Aurora" style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.aurora;" vertex="1" parent="cloud">
          <mxGeometry x="430" y="120" width="60" height="60" as="geometry" />
        </mxCell>
        <mxCell id="e-svc-db" value="read / write" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="cloud" source="svc" target="db">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

/** Ids in the order draw.io would paint them: document order within `<root>`. */
function paintOrder(source: string): string[] {
  return [...source.matchAll(/<mxCell\b[^>]*?\bid="([^"]*)"/g)].map((match) => match[1]);
}

test('moves AWS4 connector lines behind the icons they connect', () => {
  const ordered = paintOrder(normalizeAws4PaintOrder(AWS_PAINT_ORDER_SOURCE));

  // The edge shares parent "cloud" with svc/db, so it must be declared before both to paint under.
  assert.ok(ordered.indexOf('e-svc-db') < ordered.indexOf('svc'));
  assert.ok(ordered.indexOf('e-svc-db') < ordered.indexOf('db'));

  // Nothing dropped, and every cell still follows its own parent (mxCodec resolves `parent` by id).
  assert.deepEqual([...ordered].sort(), paintOrder(AWS_PAINT_ORDER_SOURCE).sort());
  assert.ok(ordered.indexOf('cloud') < ordered.indexOf('e-svc-db'));
  assert.ok(ordered.indexOf('0') < ordered.indexOf('1'));
});

test('paint-order rewrite is idempotent', () => {
  const once = normalizeAws4PaintOrder(AWS_PAINT_ORDER_SOURCE);
  assert.equal(normalizeAws4PaintOrder(once), once);
});

test('leaves non-AWS4 diagrams alone so swimlane arrows keep painting over lane fills', () => {
  const swimlane = `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="lane" value="QA" style="swimlane;fillColor=#d5e8d4;" vertex="1" parent="1"><mxGeometry as="geometry" /></mxCell>
        <mxCell id="cross" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="lane" target="lane"><mxGeometry as="geometry" /></mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
  assert.equal(normalizeAws4PaintOrder(swimlane), swimlane);
});

test('reorders object-wrapped AWS4 cells by the id on the wrapper', () => {
  const wrapped = `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <object id="icon" label="Amazon S3" owner="platform"><mxCell style="shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.s3;" vertex="1" parent="1"><mxGeometry as="geometry" /></mxCell></object>
        <mxCell id="wire" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" target="icon"><mxGeometry as="geometry" /></mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
  const ordered = normalizeAws4PaintOrder(wrapped);

  assert.ok(ordered.indexOf('id="wire"') < ordered.indexOf('id="icon"'));
  assert.ok(ordered.includes('owner="platform"'), 'wrapper attributes survive the rewrite');
  assert.ok(ordered.includes('<mxGeometry as="geometry" /></mxCell></object>'), 'wrapper stays intact');
});

test('normalizeDrawioSource applies both the AWS4 colours and the paint order', () => {
  const normalized = normalizeDrawioSource(AWS_PAINT_ORDER_SOURCE, 'aws');
  const ordered = paintOrder(normalized);

  assert.match(normalized, /resIcon=mxgraph\.aws4\.aurora;fillColor=#C925D1;/);
  assert.ok(ordered.indexOf('e-svc-db') < ordered.indexOf('db'));
});

/** Three icons in a row on the default layer, so absolute geometry is what's written. The edge
 * runs src -> dst straight through `obstacle`, putting its midpoint label on the obstacle's face. */
function labelFixture(options: { edgeGeometry?: string; obstacleY?: number } = {}): string {
  const geometry = options.edgeGeometry ?? '<mxGeometry relative="1" as="geometry" />';
  const icon = 'shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.fargate;';
  return `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="src" value="Src" style="${icon}" vertex="1" parent="1"><mxGeometry x="100" y="100" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="obstacle" value="Obstacle" style="${icon}" vertex="1" parent="1"><mxGeometry x="300" y="${options.obstacleY ?? 100}" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="dst" value="Dst" style="${icon}" vertex="1" parent="1"><mxGeometry x="500" y="100" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="wire" value="objects" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="src" target="dst">${geometry}</mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
}

/** The `x` written onto the edge's own geometry — mxGraph reads it as the label's position along
 * the edge, -1 at the source end, 0 at the midpoint, 1 at the target end. */
function labelPosition(source: string): string | undefined {
  const edge = /<mxCell id="wire"[\s\S]*?<\/mxCell>/.exec(source)?.[0] ?? '';
  return /<mxGeometry\b[^>]*?\bx="([^"]*)"/.exec(edge)?.[1];
}

test('slides an edge label off the icon its midpoint lands on', () => {
  const placed = normalizeAws4LabelPlacement(labelFixture());
  const x = labelPosition(placed);

  assert.ok(x !== undefined, 'a label sitting on an icon gets an explicit position');
  assert.ok(Number(x) !== 0, 'and it is moved off the midpoint');

  // The whole point: the resolved anchor clears the obstacle's 300..360 span. The edge runs from
  // the source's right edge (x=160) to the target's left edge (x=500) at a constant y.
  const anchorX = 160 + ((Number(x) + 1) / 2) * 340;
  assert.ok(anchorX + 28 < 300 || anchorX - 28 > 360, `anchor ${anchorX} still overlaps the icon`);
});

test('leaves a label alone when nothing covers it', () => {
  // Drop the obstacle out of the edge's row; the midpoint label is then in clear space.
  assert.equal(labelPosition(normalizeAws4LabelPlacement(labelFixture({ obstacleY: 400 }))), undefined);
});

test('never overrides a label the author positioned', () => {
  const authored = labelFixture({ edgeGeometry: '<mxGeometry x="0.3" relative="1" as="geometry" />' });
  assert.equal(normalizeAws4LabelPlacement(authored), authored);

  const offset = labelFixture({
    edgeGeometry: '<mxGeometry relative="1" as="geometry"><mxPoint x="12" y="-8" as="offset" /></mxGeometry>',
  });
  assert.equal(normalizeAws4LabelPlacement(offset), offset);
});

test('skips edges routed by hand, whose path the estimator cannot know', () => {
  const routed = labelFixture({
    edgeGeometry: '<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="330" y="40" /></Array></mxGeometry>',
  });
  assert.equal(normalizeAws4LabelPlacement(routed), routed);
});

test('label placement is idempotent and leaves non-AWS4 diagrams alone', () => {
  const once = normalizeAws4LabelPlacement(labelFixture());
  assert.equal(normalizeAws4LabelPlacement(once), once);

  const swimlane = `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="a" style="swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="b" style="swimlane;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="e" value="x" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry" /></mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
  assert.equal(normalizeAws4LabelPlacement(swimlane), swimlane);
});

test('resolved labels do not land on each other', () => {
  // Two labelled edges whose midpoints both fall near the same icon.
  const icon = 'shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.fargate;';
  const crowded = `<mxfile><diagram><mxGraphModel><root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="src" style="${icon}" vertex="1" parent="1"><mxGeometry x="100" y="100" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="mid" style="${icon}" vertex="1" parent="1"><mxGeometry x="300" y="100" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="far" style="${icon}" vertex="1" parent="1"><mxGeometry x="700" y="100" width="60" height="60" as="geometry" /></mxCell>
        <mxCell id="e1" value="read / write" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="src" target="mid"><mxGeometry relative="1" as="geometry" /></mxCell>
        <mxCell id="e2" value="objects" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="src" target="far"><mxGeometry relative="1" as="geometry" /></mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
  const placed = normalizeAws4LabelPlacement(crowded);

  const anchor = (id: string, from: number, to: number) => {
    const edge = new RegExp(`<mxCell id="${id}"[\\s\\S]*?</mxCell>`).exec(placed)?.[0] ?? '';
    const x = Number(/<mxGeometry\b[^>]*?\bx="([^"]*)"/.exec(edge)?.[1] ?? '0');
    return from + ((x + 1) / 2) * (to - from);
  };
  // e1 runs 160..300, e2 runs 160..700; both at y=130.
  assert.ok(Math.abs(anchor('e1', 160, 300) - anchor('e2', 160, 700)) > 40, 'labels were separated');
});
