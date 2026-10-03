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
import { formatSpeed } from './format';
import { IconSpinner } from './icons';

// Small building blocks of the card: speed segments, the two-track mixer
// slider, and the sound-processing sliders.

// ---- Speed -----------------------------------------------------------------

export function SpeedSegments({ speeds, value, onChange, disabled, pending }: {
    speeds: readonly number[];
    value: number;
    onChange: (speed: number) => void;
    disabled?: boolean;
    pending?: number | null;
}) {
    const name = useId();
    return (
        <div className="rtd-seg" role="radiogroup" aria-label="Playback speed" aria-busy={pending != null}>
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
    const available = state.statusB !== 'unavailable';
    // Without stem B the slider stays usable only to bring a value
    // left over from the previous clip back down.
    const disabled = state.clipId === null || (!available && mix <= 0);
    const hint = state.clipId === null
        ? 'Load a clip first'
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
            <span className="rtd-mixer-end" aria-hidden="true">Stem B</span>
            <span className="rtd-mixer-status" aria-live="polite">
                {state.statusB === 'loading' ? <IconSpinner /> : state.statusB === 'error' ? '!' : null}
            </span>
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
            <div className="rtd-sound-foot">
                <span className="rtd-sound-note">Previewed on the waveform</span>
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
