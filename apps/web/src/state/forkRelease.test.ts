import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { forkReleasePublishedAtom } from "./forkRelease";

const version = "0.0.46-netpro2k.1";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = forkReleasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("forkReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks only the fork release API without tracing headers", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        tag_name: `v${version}`,
        draft: false,
        assets: [{ name: "SHA256SUMS" }, { name: `t3-${version}-linux-x64.tar.gz` }],
      }),
    );

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/netpro2k/t3code/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("reports a version absent from the fork as unpublished", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
  });

  it.each([
    {
      tag_name: `v${version}`,
      draft: true,
      assets: [{ name: "SHA256SUMS" }, { name: `t3-${version}-linux-x64.tar.gz` }],
    },
    { tag_name: `v${version}`, draft: false, assets: [] },
    { tag_name: "v99.0.0", draft: false, assets: [] },
  ])("does not offer draft, incomplete, or unrelated releases: %j", async (release) => {
    fetchMock.mockImplementation(async () => Response.json(release));
    const result = await settledCheck();
    expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
  });

  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
