const actualByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
)!.get!;
/** Private wire framing refusal; never a native process-memory observation. */
export class SemanticWireRefusal extends Error {}

/**
 * Charges WebSocket message length from its original frame header before payload
 * forwarding or downstream SDK JSON parsing. Compression and reserved opcodes are
 * refused; fragmentation shares one message budget. No website payload is copied.
 */
export class SemanticFrameBudget {
  private readonly header = new Uint8Array(14);
  private headerBytes = 0;
  private expected = 2;
  private remaining = 0;
  private messageBytes = 0;
  private fragmented = false;
  private final = false;
  private dataFrame = false;
  private closed = false;
  constructor(
    private readonly masked: boolean,
    private readonly maxBytes = 1048576
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576)
      throw new SemanticWireRefusal('SEMANTIC_WIRE_BUDGET');
  }
  /** Admit this actual chunk without retaining payload or trusting caller lengths. */
  admit(chunk: Uint8Array): void {
    if (this.closed) throw new SemanticWireRefusal('SEMANTIC_WIRE_CLOSED');
    try {
      const length = Reflect.apply(actualByteLength, chunk, []) as number;
      for (let offset = 0; offset < length;) {
        if (this.remaining > 0) {
          const entered = Math.min(this.remaining, length - offset);
          this.remaining -= entered;
          offset += entered;
          if (this.remaining === 0) this.endFrame();
          continue;
        }
        this.header[this.headerBytes++] = chunk[offset++]!;
        if (this.headerBytes === 2) {
          const encoded = this.header[1]! & 127;
          this.expected =
            2 + (encoded === 126 ? 2 : encoded === 127 ? 8 : 0) + (this.masked ? 4 : 0);
        }
        if (this.headerBytes === this.expected) this.beginFrame();
      }
    } catch (reason) {
      this.closed = true;
      throw reason;
    }
  }
  private beginFrame(): void {
    const first = this.header[0]!,
      second = this.header[1]!,
      opcode = first & 15;
    if (
      first & 112 ||
      Boolean(second & 128) !== this.masked ||
      ![0, 1, 2, 8, 9, 10].includes(opcode)
    )
      throw new SemanticWireRefusal('SEMANTIC_WIRE_FRAME');
    const encoded = second & 127;
    let length = encoded;
    if (encoded === 126) {
      length = (this.header[2]! << 8) | this.header[3]!;
      if (length < 126) throw new SemanticWireRefusal('SEMANTIC_WIRE_LENGTH');
    }
    if (encoded === 127) {
      // This channel never admits a 64-bit payload: its cap is below 2^20.
      if (this.header.slice(2, 6).some((value) => value !== 0))
        throw new SemanticWireRefusal('SEMANTIC_WIRE_LENGTH');
      length =
        this.header[6]! * 16777216 +
        this.header[7]! * 65536 +
        this.header[8]! * 256 +
        this.header[9]!;
      if (length < 65536) throw new SemanticWireRefusal('SEMANTIC_WIRE_LENGTH');
    }
    this.final = Boolean(first & 128);
    this.dataFrame = opcode < 8;
    if (!this.dataFrame && (!this.final || length > 125))
      throw new SemanticWireRefusal('SEMANTIC_WIRE_CONTROL');
    if (this.dataFrame) {
      if (opcode === 0 ? !this.fragmented : this.fragmented)
        throw new SemanticWireRefusal('SEMANTIC_WIRE_FRAGMENT');
      if (opcode !== 0) this.messageBytes = 0;
      if (length > this.maxBytes - this.messageBytes)
        throw new SemanticWireRefusal('SEMANTIC_WIRE_EXCEEDED');
      this.messageBytes += length;
      this.fragmented = !this.final;
    }
    this.remaining = length;
    if (length === 0) this.endFrame();
  }
  private endFrame(): void {
    if (this.dataFrame && this.final) this.messageBytes = 0;
    this.headerBytes = 0;
    this.expected = 2;
  }
  /** EOF is clean only after every original frame and fragmented message returned. */
  finish(): void {
    this.closed = true;
    if (this.headerBytes || this.remaining || this.fragmented)
      throw new SemanticWireRefusal('SEMANTIC_WIRE_INCOMPLETE');
  }
}
