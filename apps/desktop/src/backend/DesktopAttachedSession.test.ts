import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes, authScopeResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { readAttachedSessionToken } from "./DesktopAttachedSession.ts";

const session = {
  sessionId: "desktop-session",
  token: "saved-bearer",
  expiresAt: "2100-01-01T00:00:00Z",
};
const state = {
  authenticated: true,
  ...authScopeResponse(AuthStandardClientScopes),
  sessionMethod: "bearer-access-token",
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
};

describe("readAttachedSessionToken", () => {
  it.effect.each([
    {
      name: "valid",
      contents: JSON.stringify(session),
      response: state,
      expected: "saved-bearer",
      requests: 1,
    },
    { name: "missing", contents: null, response: state, expected: null, requests: 0 },
    { name: "malformed", contents: "{", response: state, expected: null, requests: 0 },
    {
      name: "expired",
      contents: JSON.stringify({ ...session, expiresAt: "1960-01-01T00:00:00Z" }),
      response: state,
      expected: null,
      requests: 0,
    },
    {
      name: "revoked",
      contents: JSON.stringify(session),
      response: { ...state, authenticated: false },
      expected: null,
      requests: 1,
    },
    {
      name: "insufficient scopes",
      contents: JSON.stringify(session),
      response: { ...state, ...authScopeResponse(["orchestration:read"]) },
      expected: null,
      requests: 1,
    },
    {
      name: "explicitly denied permissions despite legacy scopes",
      contents: JSON.stringify(session),
      response: { ...state, scopes: AuthStandardClientScopes, permissions: [] },
      expected: null,
      requests: 1,
    },
    {
      name: "missing administrative permission",
      contents: JSON.stringify(session),
      response: {
        ...state,
        permissions: AuthStandardClientScopes.filter((scope) => scope !== "access:write"),
      },
      expected: null,
      requests: 1,
    },
  ])("handles a $name saved session", (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attached-session-" });
      const sessionPath = path.join(dir, "desktop-session.json");
      if (scenario.contents !== null) yield* fs.writeFileString(sessionPath, scenario.contents);
      let requests = 0;
      const result = yield* readAttachedSessionToken(sessionPath, "http://127.0.0.1:3773").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests++;
            assert.equal(request.url, "http://127.0.0.1:3773/api/auth/session");
            assert.equal(request.headers.authorization, "Bearer saved-bearer");
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json(scenario.response)),
            );
          }),
        ),
      );
      assert.equal(Option.getOrNull(result), scenario.expected);
      assert.equal(requests, scenario.requests);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
