# OpenMemory web dashboard

Next.js dashboard built with the App Router, Tailwind, and shadcn/ui.

## Project design studio

The Design tab supports draw.io XML, Mermaid text, and the native React Flow canvas. New diagrams
open in the draw.io studio by default so the editor and read-only project viewer render the exact
same portable mxGraph document. The embedded studio includes the general, AWS, BPMN, flowchart,
and UML shape libraries used by the reference diagrams in `docs/refer/draw/`.

By default the Docker stack serves the sibling draw.io checkout locally at
`http://localhost:18081`. The checkout is mounted read-only into the `drawio` container, and both
the editor and viewer run in draw.io's offline/stealth modes. No public diagrams.net service is
required at runtime.

| Variable | Default |
| --- | --- |
| `DRAWIO_WEBAPP_PATH` | `../drawio/src/main/webapp` |
| `DRAWIO_PORT` | `18081` |
| `NEXT_PUBLIC_DRAWIO_EDITOR_URL` | `http://localhost:18081` |
| `NEXT_PUBLIC_DRAWIO_VIEWER_URL` | `http://localhost:18081` |

Because `NEXT_PUBLIC_*` values are compiled into the browser bundle, rebuild the web image after
changing either URL. `DRAWIO_WEBAPP_PATH` may point at another compatible local draw.io checkout.
