// Sets of events of one sample (populations), in the smaller of two forms: a bitset of one bit per
// event when the set is large, or its sorted event indices when it is small. At ten million events
// a bitset takes 1.25 MB whatever the population, where indices take 4 bytes per member; indices
// win below 1/32 of the events. `null` stands for every event throughout, as elsewhere.

const CHUNK = 4096;

export class EventSet {
  // size: the sample's event count. Exactly one of bits (Uint32Array of ⌈size/32⌉ words) and
  // indices (sorted Uint32Array) is given; count is the number of members.
  constructor(size, { bits = null, indices = null, count }) {
    this.size = size;
    this.bits = bits;
    this.indices = indices;
    this.count = count ?? (indices ? indices.length : popcount(bits));
  }

  static empty(size) {
    return new EventSet(size, { indices: new Uint32Array(0), count: 0 });
  }

  static fromIndices(indices, size) {
    return compact(new EventSet(size, { indices, count: indices.length }));
  }

  // A bitset, kept as one when that is smaller.
  static fromBits(bits, size, count) {
    return compact(new EventSet(size, { bits, count }));
  }

  get byteLength() {
    return (this.bits ?? this.indices).byteLength;
  }

  has(e) {
    if (this.bits) return (this.bits[e >>> 5] & (1 << (e & 31))) !== 0;
    let lo = 0;
    let hi = this.indices.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.indices[mid];
      if (v === e) return true;
      if (v < e) lo = mid + 1; else hi = mid - 1;
    }
    return false;
  }

  // Sorted member indices (a new array for a bitset; the stored one otherwise).
  toIndices() {
    if (this.indices) return this.indices;
    const out = new Uint32Array(this.count);
    let n = 0;
    const { bits } = this;
    for (let w = 0; w < bits.length; w += 1) {
      let word = bits[w];
      const base = w << 5;
      while (word !== 0) {
        const low = word & -word;
        out[n++] = base + 31 - Math.clz32(low);
        word ^= low;
      }
    }
    return out;
  }

  toBits() {
    if (this.bits) return this.bits;
    const bits = new Uint32Array((this.size + 31) >>> 5);
    for (const e of this.indices) bits[e >>> 5] |= 1 << (e & 31);
    return bits;
  }
}

function popcount(bits) {
  let count = 0;
  for (let w = 0; w < bits.length; w += 1) {
    let v = bits[w];
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    count += (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
  }
  return count;
}

// The smaller form: indices when fewer than 1/32 of the events are members.
function compact(set) {
  const small = set.count * 32 < set.size;
  if (small && set.bits) return new EventSet(set.size, { indices: set.toIndices(), count: set.count });
  if (!small && set.indices) return new EventSet(set.size, { bits: set.toBits(), count: set.count });
  return set;
}

// The number of members of a set, sorted index array or null (every one of `size` events).
export function sizeOf(set, size) {
  if (set === null) return size;
  if (set instanceof EventSet) return set.count;
  return set.length;
}

// Calls fn(indices, length) with successive chunks of the members, in increasing order, for hot
// loops that must treat every form alike. `set` is an EventSet, a sorted index array or null (all
// `size` events). The chunk array is reused between calls; fn must not keep it.
export function forEachChunk(set, size, fn) {
  if (set && !(set instanceof EventSet)) {
    if (set.length) fn(set, set.length);
    return;
  }
  if (set && set.indices) {
    if (set.indices.length) fn(set.indices, set.indices.length);
    return;
  }
  const chunk = new Uint32Array(CHUNK + 32);
  let n = 0;
  if (set === null) {
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(size, start + CHUNK);
      for (let e = start; e < end; e += 1) chunk[e - start] = e;
      fn(chunk, end - start);
    }
    return;
  }
  const { bits } = set;
  for (let w = 0; w < bits.length; w += 1) {
    let word = bits[w];
    if (word === 0) continue;
    const base = w << 5;
    if (word === 0xffffffff) {
      for (let b = 0; b < 32; b += 1) chunk[n + b] = base + b;
      n += 32;
      if (n >= CHUNK) {
        fn(chunk, n);
        n = 0;
      }
      continue;
    }
    while (word !== 0) {
      const low = word & -word;
      chunk[n++] = base + 31 - Math.clz32(low);
      word ^= low;
    }
    if (n >= CHUNK) {
      fn(chunk, n);
      n = 0;
    }
  }
  if (n) fn(chunk, n);
}

// Collects members into a bitset while a gate is evaluated, then keeps the smaller form.
export class SetBuilder {
  constructor(size) {
    this.size = size;
    this.bits = new Uint32Array((size + 31) >>> 5);
    this.count = 0;
  }

  add(e) {
    this.bits[e >>> 5] |= 1 << (e & 31);
    this.count += 1;
  }

  // The set; `all` (null) when every event is a member and `allowAll` is set.
  finish(allowAll = false) {
    if (allowAll && this.count === this.size) return null;
    return EventSet.fromBits(this.bits, this.size, this.count);
  }
}

function asSet(set, size) {
  if (set === null || set instanceof EventSet) return set;
  return EventSet.fromIndices(set, size);
}

// Members of both (null is every event).
export function intersectSets(a, b, size) {
  a = asSet(a, size);
  b = asSet(b, size);
  if (a === null) return b;
  if (b === null) return a;
  if (a.indices || b.indices) {
    const [small, other] = a.indices && (!b.indices || a.count <= b.count) ? [a, b] : [b, a];
    const out = new Uint32Array(small.count);
    let n = 0;
    for (const e of small.indices) if (other.has(e)) out[n++] = e;
    return EventSet.fromIndices(out.slice(0, n), size);
  }
  const bits = new Uint32Array(a.bits.length);
  for (let w = 0; w < bits.length; w += 1) bits[w] = a.bits[w] & b.bits[w];
  return EventSet.fromBits(bits, size);
}

// Members of either; null when that is every event.
export function unionSets(a, b, size) {
  a = asSet(a, size);
  b = asSet(b, size);
  if (a === null || b === null) return null;
  const bits = a.toBits().slice();
  if (b.bits) for (let w = 0; w < bits.length; w += 1) bits[w] |= b.bits[w];
  else for (const e of b.indices) bits[e >>> 5] |= 1 << (e & 31);
  const result = EventSet.fromBits(bits, size);
  return result.count === size ? null : result;
}

// Members of `universe` (null: every event) not in `remove`.
export function differenceSets(universe, remove, size) {
  universe = asSet(universe, size);
  remove = asSet(remove, size);
  if (remove === null) return EventSet.empty(size);
  if (universe && universe.indices) {
    const out = new Uint32Array(universe.count);
    let n = 0;
    for (const e of universe.indices) if (!remove.has(e)) out[n++] = e;
    return EventSet.fromIndices(out.slice(0, n), size);
  }
  const bits = universe ? universe.bits.slice() : allBits(size);
  if (remove.bits) for (let w = 0; w < bits.length; w += 1) bits[w] &= ~remove.bits[w];
  else for (const e of remove.indices) bits[e >>> 5] &= ~(1 << (e & 31));
  return EventSet.fromBits(bits, size);
}

function allBits(size) {
  const bits = new Uint32Array((size + 31) >>> 5).fill(0xffffffff);
  const tail = size & 31;
  if (tail) bits[bits.length - 1] = (1 << tail) - 1;
  return bits;
}
