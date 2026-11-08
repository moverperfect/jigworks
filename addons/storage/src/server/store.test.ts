import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStore } from "./fake-store";
import { collection } from "./store";

interface Signup {
  name: string;
  coming: boolean;
}

describe("the store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds records with an ID, and lists them in the order they were added", async () => {
    const signups = collection<Signup>(fakeStore(), "signups");
    const ada = await signups.add({ name: "Ada", coming: true });
    const grace = await signups.add({ name: "Grace", coming: false });
    expect(ada).toEqual({ id: expect.any(String), name: "Ada", coming: true });
    expect(grace.id).not.toBe(ada.id);
    expect(await signups.list()).toEqual([ada, grace]);
    expect(await signups.get(grace.id)).toEqual(grace);
  });

  it("keeps the order of records added while the clock stands still", async () => {
    vi.useFakeTimers();
    const signups = collection<Signup>(fakeStore(), "signups");
    const names = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Frances", "Ken"];
    for (const name of names) await signups.add({ name, coming: true });
    expect((await signups.list()).map(({ name }) => name)).toEqual(names);
  });

  it("keeps each collection apart, even when one's name starts with another's", async () => {
    const store = fakeStore();
    await collection<Signup>(store, "signups").add({ name: "Ada", coming: true });
    await collection<Signup>(store, "signups/old").add({ name: "Grace", coming: true });
    expect((await collection<Signup>(store, "signups").list()).map(({ name }) => name)).toEqual(["Ada"]);
    expect(await collection(store, "rota").list()).toEqual([]);
  });

  it("updates the fields given, keeping the rest and the ID", async () => {
    const signups = collection<Signup>(fakeStore(), "signups");
    const ada = await signups.add({ name: "Ada", coming: true });
    const updated = await signups.update(ada.id, { coming: false });
    expect(updated).toEqual({ id: ada.id, name: "Ada", coming: false });
    expect(await signups.get(ada.id)).toEqual(updated);
    expect(await signups.update("no-such-id", { coming: true })).toBe(null);
  });

  it("removes a record, and says whether there was one", async () => {
    const signups = collection<Signup>(fakeStore(), "signups");
    const ada = await signups.add({ name: "Ada", coming: true });
    expect(await signups.remove(ada.id)).toBe(true);
    expect(await signups.remove(ada.id)).toBe(false);
    expect(await signups.get(ada.id)).toBe(null);
    expect(await signups.list()).toEqual([]);
  });

  it("keeps a copy, so changing a record it returned changes nothing stored", async () => {
    const signups = collection<Signup>(fakeStore(), "signups");
    const ada = await signups.add({ name: "Ada", coming: true });
    ada.name = "Changed";
    expect((await signups.get(ada.id))?.name).toBe("Ada");
  });
});
