// The end of a stream of text, at most `limit` characters past the newest
// chunk: what a window that attaches to a terminal or a command gets of the
// output so far.
export function createRingBuffer(limit) {
  const chunks = [];
  let size = 0;
  return {
    push(data) {
      if (!data) return;
      chunks.push(data);
      size += data.length;
      while (size > limit && chunks.length > 1) size -= chunks.shift().length;
    },
    text: () => chunks.join(''),
    get size() {
      return size;
    }
  };
}
