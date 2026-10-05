import { useId, type ChangeEvent } from 'react';
import type { AudioPlayerCore, AudioPlayerState } from '../core/AudioPlayer';
import {
    COMPRESSION_DEFAULT,
    HIGH_PASS_DEFAULT_HZ,
    HIGH_PASS_MAX_HZ,
    OUTPUT_DEFAULT_DB,
    OUTPUT_MAX_DB,
    OUTPUT_MIN_DB,
    formatHighPassLabel,
    formatOutputGainLabel,
    formatPercentLabel,
    mixGains,
} from '../core/controls';
import { paramToUnit, unitToParam, type EffectState, type PluginParam } from '../core/effects/types';
import { formatSpeed } from './format';
import { IconSpinner } from './icons';

// Small building blocks of the card: speed segments, the two-track mixer
// slider, and the sound-processing sliders.

// ---- Speed -----------------------------------------------------------------

export function SpeedSegments({ speeds, value, onChange, disabled, pending, pitchNote }: {
    speeds: readonly number[];
    value: number;
    onChange: (speed: number) => void;
    disabled?: boolean;
    pending?: number | null;
    /** The source cannot keep the pitch (a prepared clip): say so, visibly. */
    pitchNote?: boolean;
}) {
    const name = useId();
    const shifted = !!pitchNote && Math.abs(value - 1) >= 0.001;
    return (
        <div
            className="rtd-seg"
            role="radiogroup"
            aria-label={pitchNote ? 'Playback speed (pitch follows speed)' : 'Playback speed'}
            aria-busy={pending != null}
            data-pitch-shift={pitchNote ? (shifted ? 'on' : 'off') : undefined}
            title={pitchNote ? 'This recording plays segment by segment: speed changes shift the pitch.' : undefined}
        >
            <span className="rtd-sr-only" role="status">{pending != null ? `Preparing ${formatSpeed(pending)}` : ''}</span>
            {speeds.map((speed) => {
                const checked = Math.abs(speed - value) < 0.001;
                return (
                    <label key={speed} className="rtd-seg-item" data-checked={checked || undefined}>
                        <input
                            type="radio"
                            className="rtd-sr-input"
                            name={name}
                            value={speed}
                            checked={checked}
                            disabled={disabled}
                            onChange={() => onChange(speed)}
                        />
                        <span>{formatSpeed(speed)}{pending === speed ? <IconSpinner /> : null}</span>
                    </label>
                );
            })}
            {shifted ? <span className="rtd-pitch-note" aria-hidden="true">pitch ±</span> : null}
        </div>
    );
}

// ---- Two-track mixer: Stem A ⇄ Stem B -----------------------------------------

export function MixSlider({ core, state }: { core: AudioPlayerCore; state: AudioPlayerState }) {
    const id = useId();
    const mix = state.processing.mix;
    const [gainA, gainB] = mixGains(mix, state.mixLaw);
    const valueText = gainB <= 0 ? 'Stem A only' : gainA <= 0 ? 'Stem B only'
        : `Stem A ${Math.round(gainA * 100)}%, stem B ${Math.round(gainB * 100)}%`;
    const available = state.statusB !== 'unavailable' && state.statusB !== 'processing';
    const stems = state.capabilities.stems ?? [];
    // Without stem B the slider stays usable only to bring a value
    // left over from the previous clip back down.
    const disabled = state.clipId === null || (!available && mix <= 0);
    const hint = state.clipId === null
        ? 'Load a clip first'
        : state.statusB === 'processing'
            ? 'Stem B is being prepared on the server…'
            : !available
            ? 'No stem B for this clip'
            : state.statusB === 'error'
                ? 'Stem B could not be loaded; stem A keeps playing'
                : 'Mix between stem A and stem B';

    const onChange = (event: ChangeEvent<HTMLInputElement>) => {
        const next = Number(event.currentTarget.value) / 100;
        if (!available && next > core.getState().processing.mix) return;
        core.setMix(next);
    };

    return (
        <div className="rtd-mixer" data-disabled={disabled || undefined} title={hint}>
            <label className="rtd-mixer-end" htmlFor={id}>Stem A</label>
            <input
                id={id}
                type="range"
                className="rtd-range"
                min={0}
                max={100}
                step={1}
                value={Math.round(mix * 100)}
                disabled={disabled}
                aria-label="Mix from stem A to stem B"
                aria-valuetext={valueText}
                aria-describedby={`${id}-hint`}
                style={{ ['--rtd-fill' as string]: `${mix * 100}%` }}
                onChange={onChange}
                onDoubleClick={() => core.setMix(state.mixLaw === 'separation' ? 0.5 : 0)}
            />
            {stems.length > 1 ? (
                // Prepared clips with more than one stem: which one the knob blends with.
                <select
                    className="rtd-mixer-stem"
                    aria-label="Stem B"
                    value={state.stem ?? ''}
                    onChange={(event) => core.setStem(event.currentTarget.value)}
                >
                    {stems.map((stem) => <option key={stem.key} value={stem.key}>{stem.label ?? stem.key}</option>)}
                </select>
            ) : <span className="rtd-mixer-end" aria-hidden="true">Stem B</span>}
            <span className="rtd-mixer-status" aria-live="polite">
                {state.statusB === 'loading' || state.statusB === 'processing' ? <IconSpinner /> : state.statusB === 'error' ? '!' : null}
            </span>
            {state.statusB === 'processing' ? <span className="rtd-mixer-note" data-stem-processing="">processing…</span> : null}
            <span id={`${id}-hint`} className="rtd-sr-only">{hint}</span>
        </div>
    );
}

// ---- Post FX -------------------------------------------------------------------

const OUTPUT_STEPS = (OUTPUT_MAX_DB - OUTPUT_MIN_DB) * 2; // 0.5 dB per step

function outputDbToStep(db: number): number {
    // Step 0 = mute, then OUTPUT_MIN_DB .. OUTPUT_MAX_DB in 0.5 dB steps.
    if (db === -Infinity) return 0;
    return Math.round((db - OUTPUT_MIN_DB) * 2) + 1;
}

function stepToOutputDb(step: number): number {
    if (step <= 0) return -Infinity;
    return OUTPUT_MIN_DB + (step - 1) / 2;
}

function SoundRow({ label, readout, min, max, step, value, onChange, onReset }: {
    label: string;
    readout: string;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
    onReset: () => void;
}) {
    const id = useId();
    const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
        <div className="rtd-sound-row">
            <label className="rtd-sound-label" htmlFor={id}>{label}</label>
            <output className="rtd-sound-value" htmlFor={id}>{readout}</output>
            <input
                id={id}
                type="range"
                className="rtd-range"
                min={min}
                max={max}
                step={step}
                value={value}
                aria-valuetext={readout}
                title="Double-click to reset"
                style={{ ['--rtd-fill' as string]: `${fill}%` }}
                onChange={(event) => onChange(Number(event.currentTarget.value))}
                onDoubleClick={onReset}
            />
        </div>
    );
}

export function SoundPanel({ core, state }: { core: AudioPlayerCore; state: AudioPlayerState }) {
    const { highPassHz, compression, outputGainDb } = state.processing;
    const isDefault = highPassHz === HIGH_PASS_DEFAULT_HZ
        && compression === COMPRESSION_DEFAULT
        && outputGainDb === OUTPUT_DEFAULT_DB;

    return (
        <div className="rtd-sound">
            <SoundRow
                label="High-pass"
                readout={formatHighPassLabel(highPassHz)}
                min={0}
                max={HIGH_PASS_MAX_HZ}
                step={10}
                value={Math.min(HIGH_PASS_MAX_HZ, Math.round(highPassHz))}
                onChange={(hz) => core.setHighPass(hz)}
                onReset={() => core.setHighPass(HIGH_PASS_DEFAULT_HZ)}
            />
            <SoundRow
                label="Compression"
                readout={formatPercentLabel(compression)}
                min={0}
                max={100}
                step={1}
                value={Math.round(compression * 100)}
                onChange={(pct) => core.setCompression(pct / 100)}
                onReset={() => core.setCompression(COMPRESSION_DEFAULT)}
            />
            <SoundRow
                label="Output gain"
                readout={formatOutputGainLabel(outputGainDb)}
                min={0}
                max={OUTPUT_STEPS + 1}
                step={1}
                value={outputDbToStep(outputGainDb)}
                onChange={(step) => core.setOutputGain(stepToOutputDb(step))}
                onReset={() => core.setOutputGain(OUTPUT_DEFAULT_DB)}
            />
            {state.effects.filter((e) => !e.plugin.builtin).map((effect) => (
                <PluginRows key={effect.id} core={core} effect={effect} />
            ))}
            <div className="rtd-sound-foot">
                <span className="rtd-sound-note" data-preview-missing={state.previewCoverage.missing.length > 0 || undefined}>
                    {state.previewCoverage.missing.length > 0
                        ? `Not in the preview: ${state.previewCoverage.missing.join(', ')}`
                        : 'Previewed on the waveform and the spectrogram'}
                </span>
                <button
                    type="button"
                    className="rtd-btn rtd-btn-quiet"
                    disabled={isDefault}
                    onClick={() => core.setProcessing({
                        highPassHz: HIGH_PASS_DEFAULT_HZ,
                        compression: COMPRESSION_DEFAULT,
                        outputGainDb: OUTPUT_DEFAULT_DB,
                    })}
                >
                    Reset
                </button>
            </div>
        </div>
    );
}

// ---- Third-party effects: rows from each plugin's schema ---------------------------

const UNIT_STEPS = 1000;

function formatParam(spec: PluginParam, value: number): string {
    if (spec.format) return spec.format(value);
    const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
    return `${value.toFixed(digits)}${spec.unit ? ` ${spec.unit}` : ''}`;
}

function PluginRows({ core, effect }: { core: AudioPlayerCore; effect: EffectState }) {
    const id = useId();
    const { plugin } = effect;
    return (
        <div className="rtd-sound-plugin" data-plugin={plugin.id} data-error={effect.error ? '' : undefined}>
            <div className="rtd-sound-plugin-head">
                <span className="rtd-sound-plugin-name">{plugin.name}</span>
                {effect.error
                    ? <span className="rtd-sound-plugin-error" title={effect.error}>failed · bypassed</span>
                    : (
                        <label className="rtd-sound-plugin-bypass" htmlFor={id}>
                            <input
                                id={id}
                                type="checkbox"
                                checked={!effect.bypassed}
                                onChange={(event: ChangeEvent<HTMLInputElement>) => core.effects.bypass(effect.id, !event.currentTarget.checked)}
                            />
                            on
                        </label>
                    )}
            </div>
            {plugin.params.map((spec) => {
                const value = effect.params[spec.id] ?? spec.default;
                const linearStep = spec.scale !== 'log' && spec.step && spec.step > 0;
                return (
                    <SoundRow
                        key={spec.id}
                        label={spec.label}
                        readout={formatParam(spec, value)}
                        min={0}
                        max={linearStep ? Math.round((spec.max - spec.min) / spec.step!) : UNIT_STEPS}
                        step={1}
                        value={linearStep ? Math.round((value - spec.min) / spec.step!) : Math.round(paramToUnit(spec, value) * UNIT_STEPS)}
                        onChange={(pos) => core.effects.setParam(effect.id, spec.id, linearStep ? spec.min + pos * spec.step! : unitToParam(spec, pos / UNIT_STEPS))}
                        onReset={() => core.effects.setParam(effect.id, spec.id, spec.default)}
                    />
                );
            })}
        </div>
    );
}
