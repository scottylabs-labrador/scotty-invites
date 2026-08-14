import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_QUESTIONS, RegisterBody, CreateEventBody } from "@scottylabs-invites/contract";

const answers = (n: number) => Array.from({ length: n }, () => ({ questionId: randomUUID(), value: "x" }));

describe("contract limits stay consistent with each other", () => {
  it("lets a guest answer every question one event can carry, plus phone and t-shirt", () => {
    const most = MAX_CUSTOM_QUESTIONS + 2;
    expect(RegisterBody.safeParse({ fullName: "Jane Tartan", custom: answers(most) }).success).toBe(true);
  });

  it("still rejects an absurd answer payload", () => {
    expect(RegisterBody.safeParse({ fullName: "Jane Tartan", custom: answers(41) }).success).toBe(false);
  });

  it("accepts required on a host question at create time", () => {
    const parsed = CreateEventBody.shape.hostQuestions.safeParse([
      { label: "GitHub handle", type: "short", required: true },
      { label: "Track", type: "select", options: ["Web", "ML"], required: false },
    ]);
    expect(parsed.success).toBe(true);
  });
});
