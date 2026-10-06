import { describe, expect, it } from "bun:test";
import { createMessageReader, writeMessage } from "./framing.ts";

function framePayload(payload: Buffer): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

function collect(maxFrameBytes = 64) {
	const messages: unknown[] = [];
	const errors: Error[] = [];
	const reader = createMessageReader(
		(message) => messages.push(message),
		(error) => errors.push(error),
		maxFrameBytes,
	);
	return { messages, errors, reader };
}

describe("frame reader", () => {
	it("reassembles frames split across reads", () => {
		const { messages, errors, reader } = collect();
		const combined = Buffer.concat([
			framePayload(Buffer.from(JSON.stringify({ type: "one" }))),
			framePayload(Buffer.from(JSON.stringify({ type: "two" }))),
		]);
		reader(combined.subarray(0, 2));
		reader(combined.subarray(2, 7));
		reader(combined.subarray(7));
		expect(messages).toEqual([{ type: "one" }, { type: "two" }]);
		expect(errors).toEqual([]);
	});

	it("does not reuse a reassembly buffer of the wrong size after a header-boundary frame", () => {
		const { messages, errors, reader } = collect();
		const frameA = framePayload(Buffer.from(JSON.stringify({ a: 1 })));
		const frameB = framePayload(Buffer.from(JSON.stringify({ bb: "1234567890" })));
		reader(frameA.subarray(0, 4));
		reader(frameA.subarray(4));
		reader(frameB.subarray(0, 6));
		reader(frameB.subarray(6));
		expect(messages).toEqual([{ a: 1 }, { bb: "1234567890" }]);
		expect(errors).toEqual([]);
	});

	it("rejects an oversized declared frame", () => {
		const { messages, errors, reader } = collect(8);
		reader(framePayload(Buffer.from(JSON.stringify({ text: "too large" }))));
		expect(messages).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toMatch(/Intercom frame length \d+ exceeds maximum 8 bytes/);
	});

	it("rejects an oversized frame before retaining the payload bytes that came with it", () => {
		const { messages, errors, reader } = collect(8);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(9, 0);
		reader(Buffer.concat([header, Buffer.alloc(1024 * 1024)]));
		expect(messages).toEqual([]);
		expect(errors.map((e) => e.message)).toEqual(["Intercom frame length 9 exceeds maximum 8 bytes"]);
	});

	it("rejects an oversized frame from its header alone", () => {
		const { messages, errors, reader } = collect(8);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(9, 0);
		reader(header);
		expect(messages).toEqual([]);
		expect(errors.map((e) => e.message)).toEqual(["Intercom frame length 9 exceeds maximum 8 bytes"]);
	});

	it("caps frames at 1 MiB by default", () => {
		const errors: Error[] = [];
		const reader = createMessageReader(() => {}, (error) => errors.push(error));
		const header = Buffer.alloc(4);
		header.writeUInt32BE(1024 * 1024 + 1, 0);
		reader(header);
		expect(errors[0]!.message).toBe("Intercom frame length 1048577 exceeds maximum 1048576 bytes");
	});

	it("reports bad JSON and a throwing handler, and stops at the bad frame", () => {
		const { messages, errors, reader } = collect();
		reader(Buffer.concat([framePayload(Buffer.from("{nope")), framePayload(Buffer.from("{}"))]));
		expect(messages).toEqual([]);
		expect(errors[0]!.message).toMatch(/^Failed to parse intercom message/);

		const thrown: Error[] = [];
		const throwing = createMessageReader(() => {
			throw new Error("boom");
		}, (error) => thrown.push(error));
		throwing(framePayload(Buffer.from("{}")));
		expect(thrown[0]!.message).toBe("Failed to handle intercom message: boom");
	});
});

describe("frame writer", () => {
	it("writes frames the reader accepts", () => {
		const chunks: Buffer[] = [];
		const { messages, errors, reader } = collect();
		writeMessage({ write: (chunk: Buffer) => chunks.push(chunk) } as never, { ok: true, text: "héllo" });
		reader(Buffer.concat(chunks));
		expect(messages).toEqual([{ ok: true, text: "héllo" }]);
		expect(errors).toEqual([]);
	});
});
