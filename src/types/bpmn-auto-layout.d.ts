// bpmn-auto-layout ships without type declarations.
declare module "bpmn-auto-layout" {
  /** Add diagram interchange (shapes and edges) to BPMN XML that lacks it. */
  export function layoutProcess(xml: string): Promise<string>;
}
