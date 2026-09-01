import { expect, test } from "vitest";
import { dashboardKeyUrl } from "./authentication.ts";
import { API_ORIGIN } from "./test/authentication-fixtures.ts";

test("dashboard URLs use production, local, and custom origins", () => {
  expect(dashboardKeyUrl(API_ORIGIN)).toBe(
    "https://www.blazingagents.com/app/keys"
  );
  expect(dashboardKeyUrl("http://localhost:8787")).toBe(
    "http://localhost:5173/app/keys"
  );
  expect(dashboardKeyUrl("https://staging.example.com")).toBe(
    "https://staging.example.com/app/keys"
  );
});
