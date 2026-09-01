import { expect, test } from "vitest";
import { AgentSelectionError, resolveAgent } from "./agent-resolution.ts";

const agents = [
  { id: "ag_AAAAAAAAAAAAAAAA", name: "Release Agent" },
  { id: "ag_BBBBBBBBBBBBBBBB", name: "release agent" },
  { id: "ag_CCCCCCCCCCCCCCCC", name: "Support Agent" },
];

test("an id-shaped selector resolves only by exact id", () => {
  expect(resolveAgent("ag_AAAAAAAAAAAAAAAA", agents)).toEqual(agents[0]);
  expect(() =>
    resolveAgent("ag_DDDDDDDDDDDDDDDD", [
      ...agents,
      {
        id: "ag_EEEEEEEEEEEEEEEE",
        name: "ag_DDDDDDDDDDDDDDDD",
      },
    ])
  ).toThrow(
    new AgentSelectionError("No Agent found with id ag_DDDDDDDDDDDDDDDD.")
  );
});

test("an exact-case full name wins before case-insensitive matches", () => {
  expect(resolveAgent("Release Agent", agents)).toEqual(agents[0]);
});

test("one case-insensitive full-name match resolves", () => {
  expect(resolveAgent("SUPPORT AGENT", agents)).toEqual(agents[2]);
});

test("ambiguous case-insensitive names list exact candidates", () => {
  expect(() => resolveAgent("RELEASE AGENT", agents)).toThrow(
    new AgentSelectionError(
      'Agent name "RELEASE AGENT" is ambiguous. Use an exact name or id:\n' +
        "- Release Agent (ag_AAAAAAAAAAAAAAAA)\n" +
        "- release agent (ag_BBBBBBBBBBBBBBBB)"
    )
  );
});

test("partial and fuzzy Agent names do not match", () => {
  expect(() => resolveAgent("Support", agents)).toThrow(
    new AgentSelectionError("No Agent found with name Support.")
  );
});
