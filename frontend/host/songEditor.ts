import { BEAT_UNITS, MAX_BEATS_PER_BAR, MAX_BPM, MIN_BPM } from "../shared/controlValues.ts";
import {
  addSection,
  autoTitle,
  currentSong,
  deleteSong,
  MAX_SAVED_SONGS,
  moveSection,
  newSong,
  removeSection,
  renameSong,
  replaceSong,
  selectSong,
  updateSection,
  type SectionPatch,
  type SongLibrary,
} from "../shared/song/edit.ts";
import {
  MAX_SECTION_BARS,
  MAX_SECTION_NAME_LENGTH,
  MAX_SONG_SECTIONS,
  MAX_SONG_TITLE_LENGTH,
  MIN_SECTION_BARS,
  MIN_SECTION_BEATS_PER_BAR,
  sectionFirstBars,
  songTotals,
  type Song,
  type SongSection,
} from "../shared/song/model.ts";
import type { PlanOptions, PlanPosition } from "../shared/song/plan.ts";
import { sectionOptionLabel, sectionProgressLabel, songTotalsLabel } from "../shared/ui/labels.ts";

/** Where the open song starts: what buildPlaybackPlan takes besides the start time. */
export type SongStart = Omit<PlanOptions, "startHostTime">;

export type SongEditorCallbacks = {
  /** The library changed (an edit, or a new, deleted or opened song) and should be saved. */
  onLibraryChange(library: SongLibrary): void;
  /** The start position or the count-in changed. */
  onStartChange(): void;
};

type NumericField = Exclude<keyof SongSection, "name">;

type SectionCard = {
  item: HTMLLIElement;
  name: HTMLInputElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  remove: HTMLButtonElement;
  fields: Record<NumericField, HTMLInputElement | HTMLSelectElement>;
  progress: HTMLParagraphElement;
};

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function smallButton(text: string, label: string): HTMLButtonElement {
  const button = create("button", "secondary compact", text);
  button.type = "button";
  button.setAttribute("aria-label", label);
  return button;
}

function numberInput(min: number, max: number, step: string, label: string): HTMLInputElement {
  const input = create("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = step;
  input.inputMode = step === "1" ? "numeric" : "decimal";
  input.setAttribute("aria-label", label);
  return input;
}

/** Changing a value the field already shows would move the caret, so only differences are written. */
function setValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (control.value !== value) control.value = value;
}

function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * The song tab: the saved songs, the sections of the open one as cards, where to start and the
 * count-in. Every edit goes through the pure helpers in song/edit.ts and is handed to
 * onLibraryChange at once. A change to the song's structure rebuilds the cards; a field change updates
 * the values in place so the field keeps focus. While playing every control is disabled and the
 * card being heard is marked.
 */
export class SongEditor {
  private library: SongLibrary;
  private startSectionIndex = 0;
  private startBar = 1;
  private playing = false;
  private cards: SectionCard[] = [];
  // The section and bar the progress line shows, so it is redrawn only when the bar changes.
  private shownProgress: string | null = null;

  private readonly songSelect: HTMLSelectElement;
  private readonly newButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly titleInput: HTMLInputElement;
  private readonly playingHint: HTMLElement;
  private readonly sectionList: HTMLOListElement;
  private readonly addButton: HTMLButtonElement;
  private readonly totalBars: HTMLElement;
  private readonly totalLength: HTMLElement;
  private readonly startSectionSelect: HTMLSelectElement;
  private readonly startBarInput: HTMLInputElement;
  private readonly countInSelect: HTMLSelectElement;

  constructor(root: HTMLElement, library: SongLibrary, private readonly callbacks: SongEditorCallbacks) {
    const find = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
    this.library = library;
    this.songSelect = find("#songSelect");
    this.newButton = find("#newSongButton");
    this.deleteButton = find("#deleteSongButton");
    this.titleInput = find("#songTitleInput");
    this.playingHint = find("#songPlayingHint");
    this.sectionList = find("#songSections");
    this.addButton = find("#addSectionButton");
    this.totalBars = find("#songTotalBars");
    this.totalLength = find("#songTotalLength");
    this.startSectionSelect = find("#startSectionSelect");
    this.startBarInput = find("#startBarInput");
    this.countInSelect = find("#countInSelect");
    this.titleInput.maxLength = MAX_SONG_TITLE_LENGTH;
    this.bindEvents();
    this.render();
  }

  get song(): Song {
    return currentSong(this.library);
  }

  startOptions(): SongStart {
    return { startSectionIndex: this.startSectionIndex, startBar: this.startBar, countInBars: Number(this.countInSelect.value) };
  }

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.updateDisabled();
  }

  /** Marks the card of the section (or the count-in's section) being heard; null clears it. */
  showPlayback(position: PlanPosition | null, countInBars: number): void {
    const key = position && `${position.kind}:${position.sectionIndex}:${position.barInSegment}`;
    if (key === this.shownProgress) return;
    this.shownProgress = key;
    const current = position ? this.cards[position.sectionIndex] : undefined;
    for (const card of this.cards) {
      const isCurrent = card === current;
      card.item.classList.toggle("is-current", isCurrent);
      if (isCurrent) card.item.setAttribute("aria-current", "true");
      else card.item.removeAttribute("aria-current");
      card.progress.hidden = !isCurrent;
    }
    if (current && position) setText(current.progress, sectionProgressLabel(position, this.song, countInBars));
  }

  private bindEvents(): void {
    this.songSelect.addEventListener("change", () => this.openLibrary(selectSong(this.library, this.songSelect.value)));
    this.newButton.addEventListener("click", () => {
      const library = newSong(this.library);
      if (library === this.library) return;
      this.openLibrary(library);
      // The auto title is selected, so typing a name replaces it.
      this.titleInput.focus();
      this.titleInput.select();
    });
    this.deleteButton.addEventListener("click", () => {
      if (!window.confirm(`「${this.song.title}」を削除しますか？この操作は元に戻せません。`)) return;
      this.openLibrary(deleteSong(this.library, this.song.id));
    });
    this.titleInput.addEventListener("input", () => {
      this.putSong(renameSong(this.song, this.titleInput.value));
      this.renderSongOptions();
      this.save();
    });
    // Left empty, the song gets an auto title once the field is done with.
    this.titleInput.addEventListener("change", () => {
      const renamed = renameSong(this.song, this.titleInput.value);
      this.putSong(renamed.title === "" ? { ...renamed, title: autoTitle(this.library, renamed.id) } : renamed);
      setValue(this.titleInput, this.song.title);
      this.renderSongOptions();
      this.save();
    });

    this.addButton.addEventListener("click", () => {
      if (this.restructure(addSection(this.song), this.startSectionIndex)) this.cards.at(-1)?.name.focus();
    });

    this.startSectionSelect.addEventListener("change", () => {
      this.startSectionIndex = Number(this.startSectionSelect.value);
      this.startBar = 1;
      this.renderStart();
      this.callbacks.onStartChange();
    });
    this.startBarInput.addEventListener("change", () => {
      const bar = Number(this.startBarInput.value);
      if (this.startBarInput.value.trim() !== "" && Number.isFinite(bar)) this.startBar = Math.floor(bar);
      this.renderStart();
      this.callbacks.onStartChange();
    });
    this.countInSelect.addEventListener("change", () => this.callbacks.onStartChange());
  }

  /** Opens the library's current song from its first section, as after choosing another song. */
  private openLibrary(library: SongLibrary): void {
    this.library = library;
    this.startSectionIndex = 0;
    this.startBar = 1;
    this.render();
    this.save();
  }

  private putSong(song: Song): void {
    this.library = replaceSong(this.library, song);
  }

  /** Called once the editor shows the change, so the host reads a consistent song and start. */
  private save(): void {
    this.callbacks.onLibraryChange(this.library);
  }

  /**
   * A section added, removed or moved: the cards are rebuilt and the start follows its section.
   * False when the edit changed nothing (a limit or an end of the list).
   */
  private restructure(song: Song, startSectionIndex: number): boolean {
    if (song === this.song) return false;
    this.putSong(song);
    this.startSectionIndex = startSectionIndex;
    this.renderSections();
    this.renderTotals();
    this.renderStart();
    this.updateDisabled();
    this.save();
    return true;
  }

  private moveSection(index: number, direction: -1 | 1): void {
    const target = index + direction;
    const start = this.startSectionIndex === index ? target : this.startSectionIndex === target ? index : this.startSectionIndex;
    if (!this.restructure(moveSection(this.song, index, direction), start)) return;
    // Keep the keyboard on the moved card, on the same arrow while it can go further.
    const card = this.cards[target];
    const same = direction < 0 ? card?.up : card?.down;
    (same && !same.disabled ? same : direction < 0 ? card?.down : card?.up)?.focus();
  }

  private removeSection(index: number): void {
    const song = removeSection(this.song, index);
    if (song !== this.song && this.startSectionIndex === index) this.startBar = 1;
    const start = this.startSectionIndex > index ? this.startSectionIndex - 1 : Math.min(this.startSectionIndex, song.sections.length - 1);
    if (!this.restructure(song, start)) return;
    const next = this.cards[Math.min(index, this.cards.length - 1)];
    (next && !next.remove.disabled ? next.remove : this.addButton).focus();
  }

  private editSection(index: number, patch: SectionPatch, writeBack: boolean): void {
    const song = updateSection(this.song, index, patch);
    this.putSong(song);
    const card = this.cards[index];
    const section = song.sections[index];
    if (writeBack && card && section) this.fillCard(card, section);
    this.renderTotals();
    this.renderStart();
    this.save();
  }

  private render(): void {
    this.renderSongOptions();
    setValue(this.titleInput, this.song.title);
    this.renderSections();
    this.renderTotals();
    this.renderStart();
    this.updateDisabled();
  }

  private renderSongOptions(): void {
    const songs = this.library.songs;
    const titles = songs.map((song) => song.title || autoTitle(this.library, song.id));
    const options = this.songSelect.options;
    if (options.length !== songs.length || songs.some((song, index) => options[index]!.value !== song.id)) {
      this.songSelect.replaceChildren(...songs.map((song, index) => new Option(titles[index], song.id)));
    } else {
      titles.forEach((title, index) => setText(options[index]!, title));
    }
    setValue(this.songSelect, this.library.currentId);
  }

  private renderSections(): void {
    this.cards = this.song.sections.map((section, index) => this.createCard(section, index));
    this.sectionList.replaceChildren(...this.cards.map((card) => card.item));
    this.shownProgress = null;
  }

  private renderTotals(): void {
    const labels = songTotalsLabel(songTotals(this.song));
    setText(this.totalBars, labels.bars);
    setText(this.totalLength, labels.length);
  }

  /** The start options follow the sections; the start stays within the song and its section. */
  private renderStart(): void {
    const song = this.song;
    const firstBars = sectionFirstBars(song);
    const labels = song.sections.map((section, index) => sectionOptionLabel(section, index, firstBars[index]!));
    const options = this.startSectionSelect.options;
    if (options.length !== labels.length) {
      this.startSectionSelect.replaceChildren(...labels.map((label, index) => new Option(label, String(index))));
    } else {
      labels.forEach((label, index) => setText(options[index]!, label));
    }
    this.startSectionIndex = Math.max(0, Math.min(this.startSectionIndex, song.sections.length - 1));
    const bars = song.sections[this.startSectionIndex]!.bars;
    this.startBar = Math.max(1, Math.min(this.startBar, bars));
    setValue(this.startSectionSelect, String(this.startSectionIndex));
    this.startBarInput.max = String(bars);
    setValue(this.startBarInput, String(this.startBar));
  }

  private updateDisabled(): void {
    const playing = this.playing;
    const sections = this.cards.length;
    const full = this.library.songs.length >= MAX_SAVED_SONGS;
    this.songSelect.disabled = playing;
    this.newButton.disabled = playing || full;
    this.newButton.title = full ? `保存できる曲は${MAX_SAVED_SONGS}曲までです` : "";
    this.deleteButton.disabled = playing;
    this.titleInput.disabled = playing;
    this.addButton.disabled = playing || sections >= MAX_SONG_SECTIONS;
    this.startSectionSelect.disabled = playing;
    this.startBarInput.disabled = playing;
    this.countInSelect.disabled = playing;
    this.playingHint.hidden = !playing;
    this.cards.forEach((card, index) => {
      card.name.disabled = playing;
      for (const field of Object.values(card.fields)) field.disabled = playing;
      card.up.disabled = playing || index === 0;
      card.down.disabled = playing || index === sections - 1;
      card.remove.disabled = playing || sections <= 1;
    });
  }

  private fillCard(card: SectionCard, section: SongSection): void {
    setValue(card.name, section.name);
    for (const field of Object.keys(card.fields) as NumericField[]) setValue(card.fields[field], String(section[field]));
  }

  private createCard(section: SongSection, index: number): SectionCard {
    const number = index + 1;
    const item = create("li", "song-section");
    const head = create("div", "song-section-head");
    const badge = create("span", "song-section-index", String(number));
    badge.setAttribute("aria-hidden", "true");
    const name = create("input");
    name.type = "text";
    name.placeholder = "名前（任意）";
    name.maxLength = MAX_SECTION_NAME_LENGTH;
    name.autocomplete = "off";
    name.setAttribute("aria-label", `セクション${number}の名前`);
    const up = smallButton("↑", `セクション${number}を上へ`);
    const down = smallButton("↓", `セクション${number}を下へ`);
    const remove = smallButton("削除", `セクション${number}を削除`);
    head.append(badge, name, up, down, remove);

    const beatUnit = create("select");
    beatUnit.setAttribute("aria-label", `セクション${number}の拍子の分母`);
    beatUnit.append(...BEAT_UNITS.map((unit) => new Option(String(unit), String(unit))));
    const fields: SectionCard["fields"] = {
      bpm: numberInput(MIN_BPM, MAX_BPM, "any", `セクション${number}のBPM`),
      beatsPerBar: numberInput(MIN_SECTION_BEATS_PER_BAR, MAX_BEATS_PER_BAR, "1", `セクション${number}の拍子の分子`),
      beatUnit,
      bars: numberInput(MIN_SECTION_BARS, MAX_SECTION_BARS, "1", `セクション${number}の小節数`),
    };
    const meter = create("span", "meter-inputs small");
    const slash = create("span", "", "/");
    slash.setAttribute("aria-hidden", "true");
    meter.append(fields.beatsPerBar, slash, fields.beatUnit);
    const row = create("div", "song-section-fields");
    for (const [text, control] of [["BPM", fields.bpm], ["拍子", meter], ["小節", fields.bars]] as const) {
      const label = create("label", "", text);
      label.append(control);
      row.append(label);
    }

    const progress = create("p", "song-progress");
    progress.hidden = true;
    item.append(head, row, progress);

    const card: SectionCard = { item, name, up, down, remove, fields, progress };
    this.fillCard(card, section);
    // Names are saved as typed and tidied once done with; numbers are normalized when committed.
    name.addEventListener("input", () => this.editSection(index, { name: name.value }, false));
    name.addEventListener("change", () => this.editSection(index, { name: name.value }, true));
    for (const field of Object.keys(fields) as NumericField[]) {
      fields[field].addEventListener("change", () => this.editSection(index, { [field]: fields[field].value }, true));
    }
    up.addEventListener("click", () => this.moveSection(index, -1));
    down.addEventListener("click", () => this.moveSection(index, 1));
    remove.addEventListener("click", () => this.removeSection(index));
    return card;
  }
}
