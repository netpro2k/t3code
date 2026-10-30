import { useAtomValue } from "@effect/atom-react";
import { CliRelease, cliReleaseHasArchive, cliReleaseTagUrl } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/** Only published fork archives make standalone servers eligible for updates. */
export const forkReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(cliReleaseTagUrl(version));
      if (response.status === 404) return false;
      const release = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.text),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CliRelease))),
      );
      return cliReleaseHasArchive(release, version);
    }).pipe(
      // Public release metadata does not need tracing headers or a CORS preflight.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`fork-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("fork-release-published:none"),
);

/** Unknown or unavailable releases never offer an update. */
export function useForkReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? forkReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
