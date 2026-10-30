import { describe, expect, it } from "vitest";
import { FrameError, FrameParser, boundaryTag, commandTag, isCommit, queryText } from "../../packages/verifier/src/proxy.ts";

// Byte builders for PostgreSQL v3 frames (no sockets anywhere in this file).
const typed = (type: string, payload: Buffer) => { const h = Buffer.alloc(5); h.write(type, 0, "latin1"); h.writeInt32BE(payload.length + 4, 1); return Buffer.concat([h, payload]); };
const cstr = (s: string) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const query = (sql: string) => typed("Q", cstr(sql));
const complete = (tag: string) => typed("C", cstr(tag));
const startup = () => { const body = Buffer.concat([Buffer.from([0, 3, 0, 0]), cstr("user"), cstr("postgres"), Buffer.from([0])]);
  const h = Buffer.alloc(4); h.writeInt32BE(body.length + 4, 0); return Buffer.concat([h, body]); };
const sslRequest = () => { const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4); return b; };

describe("PostgreSQL frame parser (client side)", () => {
  it("reads the untyped startup message, then typed frames", () => {
    const p = new FrameParser("client");
    const frames = p.push(Buffer.concat([startup(), query("BEGIN")]));
    expect(frames.map(f => [f.type, f.kind])).toEqual([[null, "startup"], ["Q", "typed"]]);
    expect(queryText(frames[1]!)).toBe("BEGIN");
    expect(Buffer.concat(frames.map(f => f.raw)).equals(Buffer.concat([startup(), query("BEGIN")]))).toBe(true);
  });
  it("classifies an SSLRequest as such and stays in the startup phase", () => {
    const p = new FrameParser("client");
    expect(p.push(sslRequest()).map(f => f.kind)).toEqual(["ssl-request"]);
    expect(p.push(startup()).map(f => f.kind)).toEqual(["startup"]);
  });
  it("reassembles a frame split across chunks, byte by byte", () => {
    const p = new FrameParser("client"), bytes = Buffer.concat([startup(), query("SET LOCAL application_name = 'ot:OPERATION'"), query("COMMIT")]);
    const frames = [...bytes].flatMap(b => p.push(Buffer.from([b])));
    expect(frames.map(f => f.type)).toEqual([null, "Q", "Q"]);
    expect(frames.map(f => queryText(f))).toEqual([null, "SET LOCAL application_name = 'ot:OPERATION'", "COMMIT"]);
  });
  it("splits several frames coalesced into one chunk", () => {
    const p = new FrameParser("client");
    p.push(startup());
    expect(p.push(Buffer.concat([query("BEGIN"), query("SELECT 1"), query("COMMIT")])).map(f => queryText(f))).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
  });
  it("rejects malformed lengths", () => {
    const p = new FrameParser("client");
    p.push(startup());
    const bad = Buffer.from([0x51, 0, 0, 0, 3]);                 // length 3 < 4
    expect(() => p.push(bad)).toThrow(FrameError);
    const huge = new FrameParser("client"); huge.push(startup());
    expect(() => huge.push(Buffer.from([0x51, 0x7f, 0xff, 0xff, 0xff]))).toThrow(FrameError);
    expect(() => new FrameParser("client").push(Buffer.from([0, 0, 0, 2]))).toThrow(FrameError);
  });
});

describe("PostgreSQL frame parser (server side)", () => {
  it("reads typed frames from the first byte and extracts CommandComplete tags", () => {
    const p = new FrameParser("server");
    const frames = p.push(Buffer.concat([complete("BEGIN"), complete("COMMIT")]));
    expect(frames.map(f => commandTag(f))).toEqual(["BEGIN", "COMMIT"]);
    expect(commandTag(p.push(typed("Z", Buffer.from("I")))[0]!)).toBeNull();
  });
});

describe("query classification", () => {
  it("recognizes exactly the guard's boundary tags", () => {
    expect(boundaryTag("SET LOCAL application_name = 'ot:ISSUANCE'")).toBe("ISSUANCE");
    expect(boundaryTag("set local application_name='ot:OPERATION';")).toBe("OPERATION");
    expect(boundaryTag("SET LOCAL application_name = 'ot:REJECTION_AUDIT'")).toBe("REJECTION_AUDIT");
    for (const s of ["SET application_name = 'ot:OPERATION'", "SET LOCAL application_name = 'ot:OTHER'", "SELECT 'ot:OPERATION'"]) expect(boundaryTag(s), s).toBeNull();
  });
  it("recognizes a COMMIT statement and nothing else", () => {
    for (const s of ["COMMIT", " commit ", "COMMIT;"]) expect(isCommit(s), s).toBe(true);
    for (const s of ["COMMIT PREPARED 'x'", "SELECT 'COMMIT'", "ROLLBACK", "END"]) expect(isCommit(s), s).toBe(false);
  });
});
