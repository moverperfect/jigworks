import type { FakePackage } from "./fake-registry.ts";

/** The installed Package `name`, cut down to the `exports` entries given and the files they import (see real-package.mjs). */
export declare function realPackage(name: string, entries: string[]): FakePackage;
