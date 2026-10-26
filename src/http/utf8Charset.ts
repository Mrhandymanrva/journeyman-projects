import type { NextFunction, Request, Response } from "express";

const UTF8_TYPES = new Set([
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/json",
  "text/json",
]);

/** Keep charset=utf-8 on HTML, CSS, JavaScript, and JSON responses. */
export function contentTypeWithUtf8(header: string): string {
  const pieces = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const media = pieces[0];
  if (!media || !UTF8_TYPES.has(media.toLowerCase())) return header;
  const params = pieces.slice(1).filter((part) => !/^charset\s*=/i.test(part));
  return [media, ...params, "charset=utf-8"].join("; ");
}

export function enforceUtf8Charset(_req: Request, res: Response, next: NextFunction): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (
      typeof name === "string" &&
      name.toLowerCase() === "content-type" &&
      typeof value === "string"
    ) {
      return setHeader(name, contentTypeWithUtf8(value));
    }
    return setHeader(name, value);
  }) as Response["setHeader"];
  next();
}
