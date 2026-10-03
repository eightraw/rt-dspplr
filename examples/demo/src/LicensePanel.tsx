import license from '../../../LICENSE.md?raw';

export function LicensePanel() {
    return (
        <section className="panel license-panel" aria-labelledby="license-heading">
            <header className="panel__head">
                <h2 id="license-heading" className="panel__title">License & attribution</h2>
                <a href="https://github.com/eightraw/rt-dspplr" target="_blank" rel="noopener noreferrer">RT-DSPPLR by SAIT Digital</a>
            </header>
            <div className="license-panel__body">
                <ul>
                    <li>Free to use, including in commercial, closed-source apps and hosted services.</li>
                    <li>The credit stays: right-click the player, or tap its ⓘ button, and it is there. Do not remove or hide it.</li>
                    <li>Ship a modified player, or serve it outside your organization, and you publish its source under the same license.</li>
                    <li>Your own application code stays closed. Options, themes and your own interface are not modifications.</li>
                </ul>
                <p>Rubber Band has separate licensing requirements.</p>
                <details>
                    <summary>Read the license</summary>
                    <pre className="license-panel__text">{license}</pre>
                </details>
            </div>
        </section>
    );
}
