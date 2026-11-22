import { RetailerConfig, RetailerBrowserEngine } from '../../../../../types/api';
import ToggleSwitch from '../../../../../components/ToggleSwitch';
import { PRESET_USER_AGENTS } from '../../index';


interface ScraperEngineSectionProps {
  draftConfig: Partial<RetailerConfig>;
  onUpdateConfig: (updates: Partial<RetailerConfig>) => void;
}

export default function ScraperEngineSection({ draftConfig, onUpdateConfig }: ScraperEngineSectionProps) {
  return (
    <div className="scraper-engine-section">
      <div className="form-grid" style={{ background: 'var(--surface)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border)', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Use Browser Scraper</span>
          <ToggleSwitch 
            active={!!draftConfig.use_browser_scraper} 
            onToggle={() => onUpdateConfig({ use_browser_scraper: !draftConfig.use_browser_scraper })} 
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Proxy Traffic</span>
          <ToggleSwitch 
            active={!!draftConfig.use_proxy} 
            onToggle={() => onUpdateConfig({ use_proxy: !draftConfig.use_proxy })} 
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
          <span>Skip Denoising</span>
          <ToggleSwitch 
            active={!!draftConfig.skip_denoising} 
            onToggle={() => onUpdateConfig({ skip_denoising: !draftConfig.skip_denoising })} 
          />
        </div>
      </div>

      {draftConfig.use_browser_scraper && (
        <div className="form-group">
          <label htmlFor="browser-engine">Browser Engine</label>
          <select
            id="browser-engine"
            className="form-control"
            value={draftConfig.browser_engine || 'chromium'}
            onChange={e => onUpdateConfig({ browser_engine: e.target.value as RetailerBrowserEngine })}
          >
            <option value="chromium">Chromium (default)</option>
            <option value="firefox">Firefox</option>
          </select>
          <small style={{ color: 'var(--text-muted)' }}>
            Try Firefox for retailers whose bot protection blocks Chromium; it may
            get through, but is not guaranteed to. Firefox keeps its own User Agent
            unless a Firefox one is set below, does not use the stealth or ad-block
            plugins, and ignores proxy credentials.
          </small>
        </div>
      )}
      
      <div className="form-group">
        <label>User Agent Profile</label>
        <select 
          className="form-control mb-2" 
          defaultValue="" 
          onChange={e => { if (e.target.value) onUpdateConfig({ user_agent: e.target.value }); }}
        >
          <option value="" disabled>Select Preset...</option>
          {PRESET_USER_AGENTS.map(p => <option key={p.label} value={p.value}>{p.label}</option>)}
        </select>
        <input 
          type="text" 
          className="form-control" 
          value={draftConfig.user_agent || ''} 
          onChange={e => onUpdateConfig({ user_agent: e.target.value })} 
          placeholder="Custom UA string..." 
        />
      </div>
      
      <div className="form-group mt-2">
        <label>HTTP Referrer</label>
        <input 
          type="text" 
          className="form-control" 
          value={draftConfig.referrer || ''} 
          onChange={e => onUpdateConfig({ referrer: e.target.value })} 
          placeholder="https://www.google.com" 
        />
      </div>
    </div>
  );
}
