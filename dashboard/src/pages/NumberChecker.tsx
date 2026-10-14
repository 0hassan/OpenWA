import { useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  Copy,
  Check,
  Send,
  Download,
  Trash2,
  Shield,
  Smartphone,
  Phone,
  Search,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { contactApi, type CheckNumberResponse } from '../services/api';
import { useToast } from '../hooks/useToast';
import './NumberChecker.css';

interface CheckResultItem extends CheckNumberResponse {
  avatarUrl?: string | null;
  timestamp: string;
}

export function NumberChecker() {
  useDocumentTitle('Number Checker - OpenWA');
  const navigate = useNavigate();
  const toast = useToast();

  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const readySessions = useMemo(
    () => sessions.filter(s => s.status?.toLowerCase() === 'ready' || s.status?.toLowerCase() === 'authenticated'),
    [sessions],
  );

  const [selectedSession, setSelectedSession] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'single' | 'batch'>('single');

  // Set default session when loaded (API requires session UUID)
  const currentSession = selectedSession || readySessions[0]?.id || '';

  // Single Check State
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isCheckingSingle, setIsCheckingSingle] = useState(false);
  const [singleResult, setSingleResult] = useState<CheckResultItem | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [recentChecks, setRecentChecks] = useState<CheckResultItem[]>([]);

  // Batch Check State
  const [batchInput, setBatchInput] = useState('');
  const [batchDelay, setBatchDelay] = useState<number>(1000);
  const [isCheckingBatch, setIsCheckingBatch] = useState(false);
  const [batchResults, setBatchResults] = useState<CheckResultItem[]>([]);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [batchFilter, setBatchFilter] = useState<'all' | 'registered' | 'unregistered'>('all');
  const cancelBatchRef = useRef(false);

  // Auto-prefix country code state
  const [autoPrefix91, setAutoPrefix91] = useState(true);

  // Format and clean phone number based on digit rules
  const formatNumberForCheck = useCallback(
    (raw: string, applyPrefix = autoPrefix91) => {
      let digits = raw.replace(/[^0-9]/g, '');
      // 1. If international dial exit code 00 is present (e.g. 009196...), strip '00'
      if (digits.startsWith('00') && digits.length >= 12) {
        digits = digits.substring(2);
      }
      // 2. If user entered +91 with domestic trunk 0 (e.g. +91 096... -> 13 digits), strip trunk 0
      if (digits.length === 13 && digits.startsWith('910')) {
        digits = '91' + digits.substring(3);
      }
      // 3. If domestic 11 digits starting with 0 (e.g. 096xxxxxxxx), strip leading 0
      if (digits.length === 11 && digits.startsWith('0')) {
        digits = digits.substring(1);
      }
      // 4. If exactly 10 digits and autoPrefix is true: impose India country code (+91)
      if (applyPrefix && digits.length === 10) {
        return '91' + digits;
      }
      // 5. If 12 digits (already has country code, e.g. 91xxxxxxxxxx) or any other format: keep as-is
      return digits;
    },
    [autoPrefix91],
  );

  // Preview formatted single number
  const singleFormattedNumber = useMemo(() => {
    return formatNumberForCheck(phoneNumber);
  }, [phoneNumber, formatNumberForCheck]);

  // Batch parsing statistics
  const batchParsedStats = useMemo(() => {
    const lines = batchInput
      .split(/[\n,;]+/)
      .map(n => n.trim())
      .filter(n => n.length > 0);

    let tenDigitsCount = 0;
    let twelveDigitsCount = 0;
    let otherCount = 0;

    const uniqueFormatted = new Set<string>();

    for (const raw of lines) {
      let d = raw.replace(/[^0-9]/g, '');
      if (d.startsWith('00') && d.length >= 12) d = d.substring(2);
      if (d.length === 13 && d.startsWith('910')) d = '91' + d.substring(3);
      if (d.length === 11 && d.startsWith('0')) d = d.substring(1);

      if (d.length === 10) {
        tenDigitsCount++;
      } else if (d.length === 12) {
        twelveDigitsCount++;
      } else if (d.length >= 7) {
        otherCount++;
      }
      const formatted = formatNumberForCheck(raw, autoPrefix91);
      if (formatted.length >= 7) {
        uniqueFormatted.add(formatted);
      }
    }

    return {
      totalLines: lines.length,
      uniqueCount: uniqueFormatted.size,
      tenDigitsCount,
      twelveDigitsCount,
      otherCount,
      list: Array.from(uniqueFormatted),
    };
  }, [batchInput, autoPrefix91, formatNumberForCheck]);

  // Perform single check
  const handleSingleCheck = async () => {
    const formatted = formatNumberForCheck(phoneNumber);
    if (!formatted) {
      toast.error('Please enter a phone number to check.');
      return;
    }
    if (!currentSession) {
      toast.error('No ready WhatsApp session available.');
      return;
    }

    setIsCheckingSingle(true);
    try {
      const res = await contactApi.checkNumber(currentSession, formatted);
      let avatar: string | null = null;
      if (res.exists && res.whatsappId) {
        try {
          const pic = await contactApi.profilePicture(currentSession, res.whatsappId);
          avatar = pic.url;
        } catch {
          // Profile picture is optional
        }
      }

      const item: CheckResultItem = {
        ...res,
        avatarUrl: avatar,
        timestamp: new Date().toLocaleTimeString(),
      };

      setSingleResult(item);
      setRecentChecks(prev => [item, ...prev.filter(p => p.number !== item.number).slice(0, 9)]);
    } catch (err) {
      toast.error('Check failed', err instanceof Error ? err.message : 'Unknown lookup error');
    } finally {
      setIsCheckingSingle(false);
    }
  };

  // Copy WhatsApp ID
  const handleCopy = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  // Perform batch check
  const handleStartBatch = async () => {
    const numbers = batchParsedStats.list;

    if (numbers.length === 0) {
      toast.error('Please enter valid phone numbers (one per line or comma-separated).');
      return;
    }
    if (!currentSession) {
      toast.error('No ready WhatsApp session available.');
      return;
    }

    setIsCheckingBatch(true);
    cancelBatchRef.current = false;
    setBatchResults([]);
    setBatchProgress({ current: 0, total: numbers.length });

    const results: CheckResultItem[] = [];

    for (let i = 0; i < numbers.length; i++) {
      if (cancelBatchRef.current) break;

      const num = numbers[i];
      try {
        const res = await contactApi.checkNumber(currentSession, num);
        const item: CheckResultItem = {
          ...res,
          timestamp: new Date().toLocaleTimeString(),
        };
        results.push(item);
        setBatchResults([...results]);
      } catch {
        results.push({
          number: num,
          exists: false,
          whatsappId: null,
          timestamp: new Date().toLocaleTimeString(),
        });
        setBatchResults([...results]);
      }

      setBatchProgress({ current: i + 1, total: numbers.length });

      if (i < numbers.length - 1 && batchDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
    }

    setIsCheckingBatch(false);
    toast.success(`Completed checking ${results.length} numbers.`);
  };

  const handleStopBatch = () => {
    cancelBatchRef.current = true;
    setIsCheckingBatch(false);
  };

  // Filter batch results
  const filteredBatchResults = useMemo(() => {
    if (batchFilter === 'registered') return batchResults.filter(r => r.exists);
    if (batchFilter === 'unregistered') return batchResults.filter(r => !r.exists);
    return batchResults;
  }, [batchResults, batchFilter]);

  // Export batch results as CSV
  const handleExportCSV = () => {
    if (batchResults.length === 0) return;
    const header = 'Phone Number,Has WhatsApp,WhatsApp ID,Checked At\n';
    const rows = batchResults
      .map(r => `"${r.number}","${r.exists ? 'Yes' : 'No'}","${r.whatsappId || ''}","${r.timestamp}"`)
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `whatsapp_account_check_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const registeredCount = batchResults.filter(r => r.exists).length;
  const unregisteredCount = batchResults.filter(r => !r.exists).length;

  return (
    <div className="number-checker">
      <PageHeader
        title="Number Checker"
        subtitle="Verify if phone numbers have active WhatsApp accounts silently without sending messages"
        badge={
          <span className="nc-status-badge registered">
            <Shield size={14} /> Zero Messages Sent
          </span>
        }
      />

      {/* Session Alert if none ready */}
      {!loadingSessions && readySessions.length === 0 && (
        <div className="nc-alert warning">
          <div className="nc-alert-icon">
            <AlertCircle size={22} />
          </div>
          <div className="nc-alert-content">
            <strong>No active WhatsApp session connected.</strong>
            <p style={{ margin: '0.25rem 0 0' }}>
              To check phone numbers, OpenWA requires at least one authenticated session.
            </p>
          </div>
          <button className="nc-alert-action" onClick={() => navigate('/sessions')}>
            <Smartphone size={16} /> Go to Sessions
          </button>
        </div>
      )}

      {/* Mode Tabs */}
      <div className="nc-tabs">
        <button className={`nc-tab ${activeTab === 'single' ? 'active' : ''}`} onClick={() => setActiveTab('single')}>
          <Phone size={18} /> Single Check
        </button>
        <button className={`nc-tab ${activeTab === 'batch' ? 'active' : ''}`} onClick={() => setActiveTab('batch')}>
          <UserCheck size={18} /> Bulk Number Checker
        </button>
      </div>

      {activeTab === 'single' ? (
        <>
          <div className="nc-grid">
            {/* Input Card */}
            <div className="nc-card">
              <h2 className="nc-card-title">Check Single Account</h2>

              <div className="nc-form-group">
                <label htmlFor="nc-single-session" className="nc-label">
                  WhatsApp Session
                </label>
                <select
                  id="nc-single-session"
                  aria-label="WhatsApp Session"
                  className="nc-input"
                  value={currentSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={readySessions.length === 0}
                >
                  {readySessions.length === 0 ? (
                    <option value="">No ready sessions available</option>
                  ) : (
                    readySessions.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.phone ? `(${s.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
                <span className="nc-hint">Queries are routed through this connected WhatsApp account.</span>
              </div>

              <div className="nc-form-group">
                <label className="nc-label">Phone Number</label>
                <div className="nc-input-row">
                  <input
                    type="text"
                    className="nc-input"
                    placeholder="e.g. 9876543210 (10 digits) or 919876543210 (12 digits)"
                    value={phoneNumber}
                    onChange={e => setPhoneNumber(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleSingleCheck();
                    }}
                    disabled={isCheckingSingle}
                  />
                  <button
                    className="nc-btn nc-btn-primary"
                    onClick={handleSingleCheck}
                    disabled={isCheckingSingle || !phoneNumber.trim() || readySessions.length === 0}
                  >
                    {isCheckingSingle ? <Loader2 size={18} className="animate-spin" /> : <Search size={18} />}
                    {isCheckingSingle ? 'Checking...' : 'Check'}
                  </button>
                </div>

                <label className="nc-checkbox-group">
                  <input
                    type="checkbox"
                    className="nc-checkbox"
                    checked={autoPrefix91}
                    onChange={e => setAutoPrefix91(e.target.checked)}
                    disabled={isCheckingSingle}
                  />
                  <span className="nc-checkbox-label">
                    Auto-prefix <strong>+91</strong> for 10-digit numbers (keep 12-digit numbers as-is)
                  </span>
                </label>

                {phoneNumber.trim() && (
                  <div className="nc-format-preview">
                    {phoneNumber.replace(/[^0-9]/g, '').length === 10 && autoPrefix91 ? (
                      <span className="nc-format-pill highlight">
                        Will check as: <strong>+{singleFormattedNumber}</strong> (10 digits &rarr; auto-prefixed with
                        91)
                      </span>
                    ) : phoneNumber.replace(/[^0-9]/g, '').length === 12 ? (
                      <span className="nc-format-pill">
                        Will check as: <strong>+{singleFormattedNumber}</strong> (12 digits &rarr; kept as-is)
                      </span>
                    ) : (
                      <span className="nc-format-pill">
                        Will check as: <strong>+{singleFormattedNumber}</strong> ({singleFormattedNumber.length} digits)
                      </span>
                    )}
                  </div>
                )}
                <span className="nc-hint">
                  {autoPrefix91
                    ? '10-digit numbers automatically get +91 prepended. 12-digit numbers remain unchanged.'
                    : 'Numbers are checked exactly as entered.'}
                </span>
              </div>

              <div className="nc-alert info" style={{ marginTop: '1.5rem', marginBottom: 0 }}>
                <div className="nc-alert-icon">
                  <Shield size={20} />
                </div>
                <div className="nc-alert-content" style={{ fontSize: '0.8125rem' }}>
                  <strong>Completely Silent:</strong> This query queries WhatsApp&apos;s registration registry directly.
                  The contact receives no notification, sound, or message.
                </div>
              </div>
            </div>

            {/* Result Card */}
            <div className="nc-card">
              <h2 className="nc-card-title">Verification Result</h2>

              {isCheckingSingle ? (
                <div className="nc-result-placeholder">
                  <Loader2 size={36} className="animate-spin" style={{ color: 'var(--primary)' }} />
                  <span>Querying WhatsApp servers...</span>
                </div>
              ) : singleResult ? (
                <div className={`nc-result-card ${singleResult.exists ? 'success' : 'not-found'}`}>
                  <div className="nc-result-top">
                    {singleResult.avatarUrl ? (
                      <img src={singleResult.avatarUrl} alt="Avatar" className="nc-avatar" />
                    ) : (
                      <div className="nc-avatar-fallback">{singleResult.exists ? 'WA' : '?'}</div>
                    )}
                    <div className="nc-result-header-text">
                      <div className="nc-result-phone">+{singleResult.number}</div>
                      {singleResult.exists ? (
                        <span className="nc-status-badge registered">
                          <CheckCircle2 size={15} /> Registered on WhatsApp
                        </span>
                      ) : (
                        <span className="nc-status-badge unregistered">
                          <XCircle size={15} /> Not Registered
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="nc-details-grid">
                    <div className="nc-detail-row">
                      <span className="nc-detail-label">Status</span>
                      <span className="nc-detail-value" style={{ fontFamily: 'inherit' }}>
                        {singleResult.exists ? 'Active Account' : 'No Account Found'}
                      </span>
                    </div>

                    {singleResult.exists && singleResult.whatsappId && (
                      <div className="nc-detail-row">
                        <span className="nc-detail-label">WhatsApp JID</span>
                        <span className="nc-detail-value">
                          {singleResult.whatsappId}
                          <button
                            className="nc-copy-btn"
                            onClick={() => handleCopy(singleResult.whatsappId!)}
                            title="Copy JID"
                          >
                            {copiedId ? <Check size={12} /> : <Copy size={12} />}
                            {copiedId ? 'Copied' : 'Copy'}
                          </button>
                        </span>
                      </div>
                    )}

                    <div className="nc-detail-row">
                      <span className="nc-detail-label">Checked At</span>
                      <span className="nc-detail-value" style={{ fontFamily: 'inherit', fontWeight: 'normal' }}>
                        {singleResult.timestamp}
                      </span>
                    </div>
                  </div>

                  {singleResult.exists && (
                    <div className="nc-result-actions">
                      <button
                        className="nc-btn nc-btn-primary"
                        style={{ flex: 1 }}
                        onClick={() => navigate('/message-tester')}
                      >
                        <Send size={16} /> Open in Message Tester
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="nc-result-placeholder">
                  <UserCheck size={40} />
                  <span>Enter a phone number on the left and click &quot;Check&quot; to see its WhatsApp status.</span>
                </div>
              )}
            </div>
          </div>

          {/* Recent Checks Table */}
          {recentChecks.length > 0 && (
            <div className="nc-history-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 className="nc-card-title" style={{ margin: 0 }}>
                  Recent Checks
                </h2>
                <button
                  className="nc-btn nc-btn-secondary"
                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.8125rem' }}
                  onClick={() => setRecentChecks([])}
                >
                  <Trash2 size={14} /> Clear History
                </button>
              </div>

              <table className="nc-history-table">
                <thead>
                  <tr>
                    <th>Phone Number</th>
                    <th>WhatsApp Status</th>
                    <th>WhatsApp ID</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recentChecks.map((item, idx) => (
                    <tr key={`${item.number}-${idx}`}>
                      <td style={{ fontWeight: 600 }}>+{item.number}</td>
                      <td>
                        {item.exists ? (
                          <span className="nc-status-badge registered">
                            <CheckCircle2 size={13} /> Registered
                          </span>
                        ) : (
                          <span className="nc-status-badge unregistered">
                            <XCircle size={13} /> Unregistered
                          </span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>{item.whatsappId || '—'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{item.timestamp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        /* Batch / Bulk Number Checker Tab */
        <div className="nc-card">
          <h2 className="nc-card-title">Bulk Number Checker</h2>

          <div className="nc-grid" style={{ marginBottom: '1.5rem' }}>
            <div>
              <div className="nc-form-group">
                <label htmlFor="nc-batch-session" className="nc-label">
                  WhatsApp Session
                </label>
                <select
                  id="nc-batch-session"
                  aria-label="WhatsApp Session"
                  className="nc-input"
                  value={currentSession}
                  onChange={e => setSelectedSession(e.target.value)}
                  disabled={readySessions.length === 0 || isCheckingBatch}
                >
                  {readySessions.length === 0 ? (
                    <option value="">No ready sessions available</option>
                  ) : (
                    readySessions.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} {s.phone ? `(${s.phone})` : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div className="nc-form-group">
                <label htmlFor="nc-batch-delay" className="nc-label">
                  Safe Pacing Delay (ms)
                </label>
                <select
                  id="nc-batch-delay"
                  aria-label="Safe Pacing Delay (ms)"
                  className="nc-input"
                  value={batchDelay}
                  onChange={e => setBatchDelay(Number(e.target.value))}
                  disabled={isCheckingBatch}
                >
                  <option value={500}>500 ms (Fast)</option>
                  <option value={1000}>1000 ms / 1 sec (Recommended)</option>
                  <option value={2000}>2000 ms / 2 sec (Extra Safe)</option>
                  <option value={3000}>3000 ms / 3 sec (High Volume Safe)</option>
                </select>
                <span className="nc-hint">
                  Adds spacing between consecutive queries to prevent WhatsApp rate limits.
                </span>
              </div>

              <div className="nc-form-group">
                <label className="nc-label">Country Code Rule</label>
                <label className="nc-checkbox-group" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    className="nc-checkbox"
                    checked={autoPrefix91}
                    onChange={e => setAutoPrefix91(e.target.checked)}
                    disabled={isCheckingBatch}
                  />
                  <span className="nc-checkbox-label">
                    Auto-prefix <strong>+91</strong> (India) for 10-digit numbers
                  </span>
                </label>
                <span className="nc-hint">
                  10-digit numbers (e.g. 96...) will get +91 prepended. 12-digit numbers will be checked as-is.
                </span>
              </div>
            </div>

            <div>
              <div className="nc-form-group">
                <label className="nc-label">Numbers to Check (One per line or comma-separated)</label>
                <textarea
                  className="nc-textarea"
                  placeholder="9612345678 (10 digits)&#10;919612345678 (12 digits)&#10;14155552671"
                  value={batchInput}
                  onChange={e => setBatchInput(e.target.value)}
                  disabled={isCheckingBatch}
                />
                {batchInput.trim() ? (
                  <div className="nc-batch-parse-summary">
                    <span>
                      📋 <strong>{batchParsedStats.uniqueCount}</strong> unique numbers parsed
                    </span>
                    {autoPrefix91 && (
                      <span className="nc-badge-sub">
                        ({batchParsedStats.tenDigitsCount} ten-digit &rarr; +91 added
                        {batchParsedStats.twelveDigitsCount > 0
                          ? `, ${batchParsedStats.twelveDigitsCount} twelve-digit preserved`
                          : ''}
                        )
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="nc-hint">
                    Paste raw 10-digit or 12-digit phone numbers. One per line or comma-separated.
                  </span>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {!isCheckingBatch ? (
              <button
                className="nc-btn nc-btn-primary"
                onClick={handleStartBatch}
                disabled={!batchInput.trim() || readySessions.length === 0}
              >
                <UserCheck size={18} /> Start Batch Check
              </button>
            ) : (
              <button className="nc-btn nc-btn-danger" onClick={handleStopBatch}>
                <Trash2 size={18} /> Stop Checking
              </button>
            )}

            {batchResults.length > 0 && !isCheckingBatch && (
              <button className="nc-btn nc-btn-secondary" onClick={handleExportCSV}>
                <Download size={18} /> Export Results (CSV)
              </button>
            )}
          </div>

          {/* Progress & Counters */}
          {(isCheckingBatch || batchResults.length > 0) && (
            <>
              {isCheckingBatch && (
                <div className="nc-progress-bar-container">
                  <div
                    className="nc-progress-bar"
                    style={{
                      width: `${(batchProgress.current / (batchProgress.total || 1)) * 100}%`,
                    }}
                  />
                </div>
              )}

              <div className="nc-batch-stats">
                <div className="nc-stat-box">
                  <div className="nc-stat-number">{batchResults.length}</div>
                  <div className="nc-stat-label">Checked</div>
                </div>
                <div className="nc-stat-box">
                  <div className="nc-stat-number" style={{ color: 'var(--success-text)' }}>
                    {registeredCount}
                  </div>
                  <div className="nc-stat-label">Registered</div>
                </div>
                <div className="nc-stat-box">
                  <div className="nc-stat-number" style={{ color: 'var(--error-text)' }}>
                    {unregisteredCount}
                  </div>
                  <div className="nc-stat-label">Not Registered</div>
                </div>
                <div className="nc-stat-box">
                  <div className="nc-stat-number">{Math.max(0, batchProgress.total - batchProgress.current)}</div>
                  <div className="nc-stat-label">Remaining</div>
                </div>
              </div>

              {/* Table Filters */}
              <div className="nc-filter-bar">
                <div className="nc-filter-btns">
                  <button
                    className={`nc-filter-btn ${batchFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('all')}
                  >
                    All ({batchResults.length})
                  </button>
                  <button
                    className={`nc-filter-btn ${batchFilter === 'registered' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('registered')}
                  >
                    Registered ({registeredCount})
                  </button>
                  <button
                    className={`nc-filter-btn ${batchFilter === 'unregistered' ? 'active' : ''}`}
                    onClick={() => setBatchFilter('unregistered')}
                  >
                    Not Registered ({unregisteredCount})
                  </button>
                </div>
              </div>

              <table className="nc-history-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Phone Number</th>
                    <th>WhatsApp Status</th>
                    <th>WhatsApp ID</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBatchResults.map((item, idx) => (
                    <tr key={`${item.number}-${idx}`}>
                      <td style={{ color: 'var(--text-muted)' }}>{idx + 1}</td>
                      <td style={{ fontWeight: 600 }}>+{item.number}</td>
                      <td>
                        {item.exists ? (
                          <span className="nc-status-badge registered">
                            <CheckCircle2 size={13} /> Registered
                          </span>
                        ) : (
                          <span className="nc-status-badge unregistered">
                            <XCircle size={13} /> Unregistered
                          </span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>{item.whatsappId || '—'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{item.timestamp}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
