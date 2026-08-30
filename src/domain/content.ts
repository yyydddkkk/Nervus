export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface JsonContentBlock {
  readonly type: "json";
  readonly value: JsonValue;
}

export interface ImageContentBlock {
  readonly type: "image";
  readonly uri: string;
  readonly mediaType?: string;
}

export interface ResourceContentBlock {
  readonly type: "resource";
  readonly uri: string;
  readonly mediaType?: string;
}

export type ContentBlock =
  | TextContentBlock
  | JsonContentBlock
  | ImageContentBlock
  | ResourceContentBlock;
