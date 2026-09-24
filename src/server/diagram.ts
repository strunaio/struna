import { BpmnModdle } from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";

/** Matches a `<bpmndi:BPMNDiagram>` element under any namespace prefix. */
const HAS_DIAGRAM = /<(?:[\w-]+:)?BPMNDiagram[\s>]/;

/** Definitions are immutable per id, so a generated layout never goes stale. */
const layouts = new Map<string, Promise<string>>();

interface FlowNode {
  $type: string;
  incoming?: FlowNode[];
  outgoing?: FlowNode[];
  sourceRef?: FlowNode;
  targetRef?: FlowNode;
  flowElements?: FlowNode[];
}

/**
 * bpmn-auto-layout walks `<incoming>`/`<outgoing>`, which hand-written BPMN
 * usually leaves out — the engine only needs `sourceRef`/`targetRef`. Without
 * them every node looks unconnected and the layout draws no edges, so derive
 * them from the flows first.
 */
async function withFlowReferences(source: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(source);

  const link = (container: FlowNode): void => {
    for (const element of container.flowElements ?? []) {
      if (element.$type === "bpmn:SequenceFlow") {
        const { sourceRef, targetRef } = element;
        if (sourceRef !== undefined) {
          sourceRef.outgoing ??= [];
          if (!sourceRef.outgoing.includes(element)) sourceRef.outgoing.push(element);
        }
        if (targetRef !== undefined) {
          targetRef.incoming ??= [];
          if (!targetRef.incoming.includes(element)) targetRef.incoming.push(element);
        }
      }
      // Sub-processes nest their own flows.
      if (element.flowElements !== undefined) link(element);
    }
  };
  for (const root of (rootElement as unknown as { rootElements?: FlowNode[] })
    .rootElements ?? []) {
    link(root);
  }

  const { xml } = await moddle.toXML(rootElement);
  return xml;
}

/**
 * BPMN XML that bpmn-js can draw. Sources written by hand (or by tools that
 * skip diagram interchange) carry no shapes or coordinates, so one is
 * generated for them; sources with their own layout are served as-is.
 */
export function diagramXml(definitionId: string, source: string): Promise<string> {
  if (HAS_DIAGRAM.test(source)) return Promise.resolve(source);

  let layout = layouts.get(definitionId);
  if (layout === undefined) {
    layout = withFlowReferences(source).then(layoutProcess);
    // A failed layout should be retried, not cached.
    layout.catch(() => layouts.delete(definitionId));
    layouts.set(definitionId, layout);
  }
  return layout;
}
