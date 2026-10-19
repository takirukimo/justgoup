// Settings: audio, feel, graphics, data reset, credits. Every change emits the full Settings.

import type { ScreenProps } from '../../core/contracts';
import type { QualityLevel, Settings } from '../../core/types';
import { BRAND } from '../../config/brand';
import { button, el, label, stagger } from '../dom';
import { chiralLockup } from '../logo';
import { header, screenRoot, segmented, sliderRow, toggleRow, topoLayer } from '../parts';
import type { ScreenView, UICtx } from '../screen';
import { pureOf, type SettingsExt } from '../../input/pure';

type P = ScreenProps['settings'];

export function createSettings(ctx: UICtx, props: P): ScreenView<P> {
  const root = screenRoot('settings', 'scr-panel');
  let s: SettingsExt = { ...props.profile.settings };
  const commit = (patch: Partial<SettingsExt>): void => {
    s = { ...s, ...patch };
    ctx.commitSettings(s as Settings);
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

  // Start over: a fresh first launch (splash → Steini's intro → name → tutorial) to try the game
  // from scratch. Wipes this device only; scores already on the boards stay online.
  const startOver = button({
    label: 'START OVER',
    icon: 'refresh',
    variant: 'danger',
    cls: 'btn-wide set-startover',
    onTap: async () => {
      const ok = await ctx.confirm(
        'Start over?',
        'This wipes your name, progress, unlocks, settings, saved problems and drafts on this device, then starts the game fresh with Steini’s intro and the tutorial. Scores already on the leaderboard stay online.',
        'START OVER',
        'KEEP MY PROGRESS',
      );
      if (!ok) return;
      if (!ctx.resetProgress()) ctx.toast('START OVER UNAVAILABLE');
    },
  });
  const startOverRow = el(
    'div',
    'row row-danger row-startover',
    el('span', 'row-txt', el('span', 'row-lbl', 'Start over'), el('span', 'row-sub', 'Play it from scratch: intro, name and tutorial. Wipes this device’s progress, settings and drafts.')),
    startOver,
  );

  // Assist visuals have nothing to show in Pure climbing: the row says so (and stays settable)
  const assistRow = toggleRow({ label: 'Assist visuals', sub: 'Limb labels, reach arcs, grip colours', icon: 'target', value: s.assist, onChange: (v) => commit({ assist: v }) });
  const assistSub = assistRow.querySelector('.row-sub');
  const paintAssist = (pure: boolean): void => {
    assistRow.classList.toggle('is-muted', pure);
    if (assistSub) assistSub.textContent = pure ? 'Hidden while Pure climbing is on' : 'Limb labels, reach arcs, grip colours';
  };
  const pureRow = toggleRow({
    label: 'Pure climbing',
    sub: 'Every mode: no HUD, meters, hints or route overlays. Your climber’s body is the feedback.',
    icon: 'pure',
    value: pureOf(s),
    onChange: (v) => {
      commit({ pure: v });
      paintAssist(v);
    },
  });
  pureRow.classList.add('row-pure');
  paintAssist(pureOf(s));

  const body = el(
    'div',
    'set-body scroll',
    section('CLIMB', 1, pureRow, assistRow),
    section(
      'AUDIO',
      2,
      sliderRow({ label: 'Sound effects', icon: 'sound', value: s.sfx, onInput: (v) => commit({ sfx: v }) }),
      sliderRow({ label: 'Music', icon: 'music', value: s.music, onInput: (v) => commit({ music: v }) }),
    ),
    section(
      'FEEL',
      3,
      toggleRow({ label: 'Haptics', sub: 'Vibrate on grabs, slips and falls', icon: 'haptic', value: s.haptics, onChange: (v) => commit({ haptics: v }) }),
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
    section('GRAPHICS', 4, el('div', 'row row-seg', el('span', 'row-txt', el('span', 'row-lbl', 'Quality'), el('span', 'row-sub', 'Auto adapts to your device')), quality.el)),
    section('DATA', 5, startOverRow),
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
      6,
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
