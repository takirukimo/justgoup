// Settings: audio, feel, graphics, data reset, credits. Every change emits the full Settings.

import type { ScreenProps } from '../../core/contracts';
import type { QualityLevel, Settings } from '../../core/types';
import { BRAND } from '../../config/brand';
import { button, el, label, stagger } from '../dom';
import { chiralLockup } from '../logo';
import { header, screenRoot, segmented, sliderRow, toggleRow, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';

type P = ScreenProps['settings'];

export function createSettings(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('settings', 'scr-panel');
  let s: Settings = { ...props.profile.settings };
  const commit = (patch: Partial<Settings>): void => {
    s = { ...s, ...patch };
    ctx.commitSettings(s);
  };

  const section = (title: string, i: number, ...rows: HTMLElement[]): HTMLElement =>
    stagger(el('section', 'set-sec', el('div', 'set-sec-h', label(title), el('i', 'set-rule')), el('div', 'set-card glass', ...rows)), i);

  const quality = segmented<QualityLevel | 'auto'>({
    options: [
      { id: 'auto', label: 'AUTO' },
      { id: 'low', label: 'LOW' },
      { id: 'medium', label: 'MED' },
      { id: 'high', label: 'HIGH' },
    ],
    value: s.quality,
    cls: 'seg-sm',
    onChange: (q) => {
      commit({ quality: q });
      ctx.setQualityClass(q);
    },
  });

  const reset = button({
    label: 'RESET PROGRESS',
    icon: 'trash',
    variant: 'danger',
    cls: 'btn-wide',
    onTap: async () => {
      const ok = await ctx.confirm(
        'Reset progress?',
        'This wipes your scores, stats, unlocks and saved problems on this device. Leaderboard entries already submitted stay online.',
        'RESET',
        'KEEP MY PROGRESS',
      );
      if (!ok) return;
      if (ctx.resetProgress()) ctx.toast('PROGRESS RESET');
      else ctx.toast('RESET UNAVAILABLE');
    },
  });

  const body = el(
    'div',
    'set-body scroll',
    section(
      'AUDIO',
      1,
      sliderRow({ label: 'Sound effects', icon: 'sound', value: s.sfx, onInput: (v) => commit({ sfx: v }) }),
      sliderRow({ label: 'Music', icon: 'music', value: s.music, onInput: (v) => commit({ music: v }) }),
    ),
    section(
      'FEEL',
      2,
      toggleRow({ label: 'Haptics', sub: 'Vibrate on grabs, slips and falls', icon: 'haptic', value: s.haptics, onChange: (v) => commit({ haptics: v }) }),
      toggleRow({ label: 'Assist visuals', sub: 'Limb labels, reach arcs, grip colours', icon: 'target', value: s.assist, onChange: (v) => commit({ assist: v }) }),
      toggleRow({
        label: 'Reduced motion',
        sub: 'Calmer camera and interface animation',
        icon: 'motion',
        value: s.reducedMotion,
        onChange: (v) => {
          commit({ reducedMotion: v });
          ctx.setReducedMotion(v);
        },
      }),
    ),
    section('GRAPHICS', 3, el('div', 'row row-seg', el('span', 'row-txt', el('span', 'row-lbl', 'Quality'), el('span', 'row-sub', 'Auto adapts to your device')), quality.el)),
    section('DATA', 4, el('div', 'row row-danger', reset)),
    stagger(
      el(
        'section',
        'credits',
        el('span', 'cr-name', BRAND.game),
        el('span', 'cr-by', label('BY'), chiralLockup('cr-lockup')),
        el(
          'div',
          'cr-lines',
          label(`DESIGN & DEVELOPMENT · ${BRAND.name} ${BRAND.sub}`),
          label(`SET AT ${BRAND.gym} · ${BRAND.guideName.toUpperCase()} INSTRUCTING`),
          label('BUILT WITH THREE.JS'),
          label('TYPE · BARLOW CONDENSED · INTER · JETBRAINS MONO'),
        ),
        label(`© ${new Date().getFullYear()} ${BRAND.name} ${BRAND.sub}`, 'cr-copy'),
      ),
      5,
    ),
  );

  root.append(topoLayer('panel-topo'), header({ title: 'Settings', kicker: 'SYSTEM · PREFERENCES' }), body);
  return {
    el: root,
    update: (p) => {
      s = { ...p.profile.settings };
      quality.set(s.quality);
    },
  };
}
