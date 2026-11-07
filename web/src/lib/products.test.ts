import { describe, expect, it } from "vitest";
import type { Workspace } from "@/lib/api/types";
import { productsOf } from "./products";

const ws = (settings: Workspace["settings"], mail_available = true) => ({ settings, mail_available }) as Workspace;

describe("productsOf", () => {
  it("has every product on until the workspace says otherwise", () => {
    expect(productsOf(undefined)).toEqual({ tickets: true, mail: true, pages: true });
    expect(productsOf(ws({}))).toEqual({ tickets: true, mail: true, pages: true });
  });

  it("follows the Tickets and Pages flags and the effective Mail availability", () => {
    expect(productsOf(ws({ tickets_enabled: false }))).toEqual({ tickets: false, mail: true, pages: true });
    expect(productsOf(ws({ mail_enabled: false }, false))).toEqual({ tickets: true, mail: false, pages: true });
    expect(productsOf(ws({ pages_enabled: false }))).toEqual({ tickets: true, mail: true, pages: false });
  });
});
