const SCRAMBLE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomGlyph() {
  const pool = SCRAMBLE_LETTERS + SCRAMBLE_LETTERS.toLowerCase();
  return pool[Math.floor(Math.random() * pool.length)];
}

export function runIdentityScramble(
  target: string,
  onUpdate: (value: string) => void,
  onComplete?: () => void,
): () => void {
  const chars = [...target];
  const settled = new Array(chars.length).fill(false);
  let tick = 0;

  const timer = window.setInterval(() => {
    tick += 1;

    let allSettled = true;
    const next = chars.map((char, index) => {
      if (/\s/.test(char)) return char;
      if (settled[index] || tick > 10 + index * 3) {
        settled[index] = true;
        return char;
      }
      allSettled = false;
      return randomGlyph();
    });

    onUpdate(next.join(""));

    if (allSettled || tick > 10 + chars.length * 3 + 8) {
      window.clearInterval(timer);
      onUpdate(target);
      onComplete?.();
    }
  }, 42);

  return () => window.clearInterval(timer);
}
