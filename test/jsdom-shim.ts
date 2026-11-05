declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: {
      document: any;
      HTMLElement: { prototype: { scrollIntoView: (this: any, ...args: any[]) => void } };
    };
  }
}
