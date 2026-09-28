// Right-hand panel: properties of the selected clip, or composition info.
import { h, mount, formatTime, KIND_LABEL } from '../ui.js';
import { clipDuration } from './model.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 4];

export class Inspector {
  constructor(container, editor) {
    this.el = container;
    this.editor = editor;
    this.pending = null;
  }

  /** Live edit (slider drag): mutate without history, commit on change. */
  live(clip, fn) {
    if (!this.pending) this.pending = this.editor.snapshot();
    fn(clip);
    this.editor.onLiveChange(clip);
  }

  done() {
    if (!this.pending) return;
    const before = this.pending;
    this.pending = null;
    this.editor.commitFrom(before);
  }

  numberInput(clip, key, { min, max, step = 0.01, factor = 1, decimals = 2 }) {
    return h('input', {
      type: 'number', min, max, step, value: +(clip[key] * factor).toFixed(decimals),
      oninput: (e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        this.live(clip, (c) => { c[key] = Math.max(min / factor, Math.min(max / factor, v / factor)); });
      },
      onchange: () => this.done(),
      onkeydown: (e) => e.stopPropagation(),
    });
  }

  slider(clip, key, label, { min, max, step, factor = 1, suffix = '' }) {
    const num = this.numberInput(clip, key, { min, max, step, factor, decimals: factor === 100 ? 0 : 2 });
    const range = h('input', {
      type: 'range', min, max, step, value: clip[key] * factor,
      oninput: (e) => {
        const v = Number(e.target.value);
        num.value = +v.toFixed(2);
        this.live(clip, (c) => { c[key] = v / factor; });
      },
      onchange: () => this.done(),
    });
    num.addEventListener('input', () => { range.value = num.value; });
    return h('label', {}, h('span', {}, `${label}${suffix ? `, ${suffix}` : ''}`), h('div', { class: 'slider-row' }, range, num));
  }

  render() {
    const { editor } = this;
    this.pending = null;
    const sel = editor.selectedClips();
    if (sel.length === 1) this.renderClip(sel[0].track, sel[0].clip);
    else if (sel.length > 1) this.renderMulti(sel);
    else this.renderComposition();
  }

  renderMulti(sel) {
    const { editor } = this;
    mount(this.el,
      h('h3', {}, `Выбрано клипов: ${sel.length}`),
      h('div', { class: 'btn-grid' },
        h('button', { onclick: () => editor.split() }, '✂ Разрезать'),
        h('button', { onclick: () => editor.duplicate() }, '⧉ Дублировать'),
        h('button', { class: 'danger', onclick: () => editor.remove(false) }, '🗑 Удалить'),
        h('button', { class: 'danger wide', onclick: () => editor.remove(true) }, '⇤ Удалить со сдвигом')));
  }

  renderComposition() {
    const { editor } = this;
    const c = editor.comp;
    const k = (key, text) => h('div', {}, h('span', { class: 'kbd' }, key), ' ', text);
    mount(this.el,
      h('h3', {}, 'Композиция'),
      h('div', { class: 'muted small', style: { marginBottom: '12px', lineHeight: 1.7 } },
        h('div', {}, `Холст: ${c.width}×${c.height}, ${c.fps} fps`),
        h('div', {}, `Длительность: ${formatTime(editor.duration(), c.fps)}${c.duration ? ' (фикс.)' : ' (авто)'}`),
        h('div', {}, `Дорожек: ${editor.tracks.length}, клипов: ${editor.tracks.reduce((n, t) => n + t.clips.length, 0)}`)),
      h('div', { class: 'btn-grid' },
        h('button', { onclick: () => editor.openSettings() }, '⚙ Холст'),
        h('button', { class: 'primary', onclick: () => editor.openExport() }, '⬇ Экспорт')),
      h('div', { class: 'group' },
        h('div', { class: 'group-title' }, 'Как монтировать'),
        h('div', { class: 'muted small help' },
          h('p', {}, 'Перетащите медиа из панели слева на дорожку или нажмите «+». Выберите клип, чтобы изменить скорость, громкость, кадрирование и положение на холсте.'),
          k('Пробел', 'воспроизведение'),
          k('S', 'разрезать по курсору'),
          k('Del', 'удалить, Shift+Del — со сдвигом'),
          k('Ctrl+D', 'дублировать'),
          k('Ctrl+Z / Ctrl+Shift+Z', 'отмена / повтор'),
          k('← →', 'кадр назад / вперёд (Shift — 1 с)'),
          k('Home / End', 'в начало / в конец'),
          k('Ctrl+колесо', 'масштаб таймлайна'),
          h('p', {}, 'Края клипа тянутся мышью (обрезка). Клип на холсте можно перетаскивать.'))));
  }

  renderClip(track, clip) {
    const { editor } = this;
    const isComp = clip.source_type === 'composition';
    const media = isComp ? null : editor.media.get(clip.media_id);
    const comp = isComp ? editor.comps.get(clip.source_composition_id) : null;
    const kind = isComp ? 'comp' : media ? media.kind : 'video';
    const isImage = kind === 'image';
    const visual = track.kind === 'video';
    const hasAudio = isComp || (media && media.has_audio);
    const fps = editor.comp.fps;

    const durText = () => `${clipDuration(clip).toFixed(2)} с (${formatTime(clipDuration(clip), fps)})`;
    const durationText = h('span', { class: 'small' }, durText());
    this.refreshReadouts = () => { durationText.textContent = durText(); };

    const speedBtns = SPEEDS.map((s) => h('button', {
      class: `icon${Math.abs(clip.speed - s) < 1e-6 ? ' active' : ''}`,
      onclick: () => editor.setSpeed(clip, s),
    }, `${s}×`));

    mount(this.el,
      h('h3', {}, h('span', { class: `badge ${kind}` }, KIND_LABEL[kind]),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, isComp ? (comp ? comp.name : '—') : (media ? media.name : '—'))),
      h('div', { class: 'btn-grid' },
        h('button', { onclick: () => editor.split(), title: 'S' }, '✂ Разрезать'),
        h('button', { onclick: () => editor.duplicate(), title: 'Ctrl+D' }, '⧉ Дублировать'),
        visual && hasAudio ? h('button', { onclick: () => editor.detachAudio(), title: 'Перенести звук на аудиодорожку' }, '🎵 Отделить звук') : null,
        h('button', { class: 'danger', onclick: () => editor.remove(false), title: 'Del' }, '🗑 Удалить'),
        h('button', { class: 'danger wide', onclick: () => editor.remove(true), title: 'Shift+Del — удалить и сдвинуть следующие клипы' }, '⇤ Удалить со сдвигом')),

      h('div', { class: 'group' },
        h('div', { class: 'group-title' }, 'Время и обрезка'),
        h('div', { class: 'two' },
          h('label', {}, h('span', {}, 'Начало на таймлайне, с'), this.numberInput(clip, 'timeline_start', { min: 0, max: 86400, step: 0.1 })),
          h('label', {}, h('span', {}, 'Длительность'), h('div', { style: { padding: '8px 0' } }, durationText))),
        !isImage && h('div', { class: 'two' },
          h('label', {}, h('span', {}, 'Вход в источнике, с'), this.numberInput(clip, 'source_in', { min: 0, max: clip.source_out - 0.05, step: 0.1 })),
          h('label', {}, h('span', {}, 'Выход в источнике, с'), this.numberInput(clip, 'source_out', { min: clip.source_in + 0.05, max: editor.timeline.sourceMax(clip), step: 0.1 }))),
        isImage && h('label', {}, h('span', {}, 'Длительность показа, с'), this.numberInput(clip, 'source_out', { min: 0.05, max: 3600, step: 0.5 })),
        !isImage && h('label', {}, h('span', {}, 'Скорость'),
          h('div', { class: 'row wrap', style: { gap: '4px' } }, speedBtns,
            h('input', {
              type: 'number', min: 0.1, max: 10, step: 0.05, value: clip.speed, style: { width: '70px' },
              onchange: (e) => editor.setSpeed(clip, Number(e.target.value)),
              onkeydown: (e) => e.stopPropagation(),
            })))),

      hasAudio && h('div', { class: 'group' },
        h('div', { class: 'group-title' }, 'Звук'),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: clip.muted, onchange: (e) => editor.commit(() => { clip.muted = e.target.checked; }) }),
          h('span', {}, 'Без звука')),
        this.slider(clip, 'volume', 'Громкость', { min: 0, max: 400, step: 1, factor: 100, suffix: '%' })),

      h('div', { class: 'group' },
        h('div', { class: 'group-title' }, 'Плавность'),
        h('div', { class: 'two' },
          h('label', {}, h('span', {}, 'Появление, с'), this.numberInput(clip, 'fade_in', { min: 0, max: 60, step: 0.1 })),
          h('label', {}, h('span', {}, 'Исчезание, с'), this.numberInput(clip, 'fade_out', { min: 0, max: 60, step: 0.1 })))),

      visual && h('div', { class: 'group' },
        h('div', { class: 'group-title' }, 'Кадр на холсте'),
        this.slider(clip, 'scale', 'Масштаб', { min: 5, max: 400, step: 1, factor: 100, suffix: '%' }),
        this.slider(clip, 'opacity', 'Непрозрачность', { min: 0, max: 100, step: 1, factor: 100, suffix: '%' }),
        h('div', { class: 'two' },
          h('label', {}, h('span', {}, 'Позиция X, px'), this.numberInput(clip, 'pos_x', { min: -20000, max: 20000, step: 1, decimals: 0 })),
          h('label', {}, h('span', {}, 'Позиция Y, px'), this.numberInput(clip, 'pos_y', { min: -20000, max: 20000, step: 1, decimals: 0 }))),
        h('div', { class: 'group-title', style: { marginTop: '6px' } }, 'Кадрирование, %'),
        h('div', { class: 'two' },
          h('label', {}, h('span', {}, 'Слева'), this.numberInput(clip, 'crop_left', { min: 0, max: 45, step: 1, factor: 100, decimals: 0 })),
          h('label', {}, h('span', {}, 'Справа'), this.numberInput(clip, 'crop_right', { min: 0, max: 45, step: 1, factor: 100, decimals: 0 })),
          h('label', {}, h('span', {}, 'Сверху'), this.numberInput(clip, 'crop_top', { min: 0, max: 45, step: 1, factor: 100, decimals: 0 })),
          h('label', {}, h('span', {}, 'Снизу'), this.numberInput(clip, 'crop_bottom', { min: 0, max: 45, step: 1, factor: 100, decimals: 0 }))),
        h('div', { class: 'row wrap' },
          h('button', { onclick: () => editor.fitClip(clip, 'fill') }, 'Заполнить холст'),
          h('button', { onclick: () => editor.fitClip(clip, 'reset') }, 'Сбросить'))),

      isComp && h('div', { class: 'group' },
        h('a', { href: `/compositions/${clip.source_composition_id}`, 'data-link': '' }, 'Открыть вложенную композицию →')));
  }
}
