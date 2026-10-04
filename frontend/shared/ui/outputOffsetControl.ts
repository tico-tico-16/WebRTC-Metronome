import { normalizeOutputOffsetMs } from "../controlValues.ts";

/**
 * Keeps the output offset number field and slider in step, reports every change,
 * and writes the clamped value back when the number field is committed.
 * Returns a reader for the current clamped offset.
 */
export function bindOutputOffsetControl(
  numberInput: HTMLInputElement,
  rangeInput: HTMLInputElement,
  onChange: (offsetMs: number) => void,
): () => number {
  const read = () => normalizeOutputOffsetMs(numberInput.value);

  numberInput.addEventListener("input", () => {
    const offsetMs = read();
    rangeInput.value = String(offsetMs);
    onChange(offsetMs);
  });
  numberInput.addEventListener("change", () => {
    numberInput.value = String(read());
  });
  rangeInput.addEventListener("input", () => {
    numberInput.value = rangeInput.value;
    onChange(read());
  });

  return read;
}
