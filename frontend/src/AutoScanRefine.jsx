/**
 * AutoScanRefine.jsx — Phase 2.5: Refine Scenarios with Context Questions
 * 
 * Shows Claude-generated questions about each selected page
 * User answers them → Claude generates better scenarios
 * Then proceeds to Testing with refined scenarios
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const API = '/api/auto-scan';

export default function AutoScanRefine({ discId, disc, selectedScreens, onComplete, onCancel }) {
  const [step, setStep] = useState('loading'); // 'loading' | 'questions' | 'answering' | 'refining' | 'complete'
  const [error, setError] = useState('');
  
  // Questions per page: { pageIdx: { pageTitle, questions: [...] } }
  const [contextQuestions, setContextQuestions] = useState({});
  
  // Answers per page: { pageIdx: { q1: 'answer text', q2: 'answer text', ... } }
  const [answers, setAnswers] = useState({});
  
  // Local editing state - uncontrolled to prevent cursor loss
  const [editingAnswers, setEditingAnswers] = useState({});
  
  // Refined scenarios per page: { pageIdx: { scenarios: [...] } }
  const [refinedScenarios, setRefinedScenarios] = useState({});
  
  const [currentPageIdx, setCurrentPageIdx] = useState(null);
  const [refining, setRefining] = useState(false);
  
  // Use refs to avoid re-renders on typing
  const textareaRefs = useRef({});

  // Load questions on mount
  useEffect(() => {
    loadQuestions();
  }, []);

  const loadQuestions = async () => {
    try {
      setError('');
      const pageIndices = Array.from(selectedScreens);
      const r = await fetch(`${API}/discover/${discId}/refine-questions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageIndices })
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        setStep('complete');
        return;
      }

      // Organize questions by page
      const q = {};
      (d.contextQuestions || []).forEach(page => {
        if (page.pageUrl) {
          const idx = Array.from(selectedScreens).find(i => {
            const screen = disc.screens[i];
            return screen && screen.url === page.pageUrl;
          });
          if (idx !== undefined) {
            q[idx] = page;
          }
        }
      });
      setContextQuestions(q);
      
      // Initialize answers object
      const a = {};
      Object.keys(q).forEach(idx => {
        a[idx] = {};
      });
      setAnswers(a);
      
      // Start with first selected page
      const firstIdx = Array.from(selectedScreens)[0];
      setCurrentPageIdx(firstIdx);
      setStep('answering');
    } catch (e) {
      setError(e.message);
      setStep('complete');
    }
  };

  const handleAnswerChange = useCallback((pageIdx, qId, value) => {
    // Just update local editing state - don't re-render the whole component
    setEditingAnswers(prev => ({
      ...prev,
      [pageIdx]: {
        ...prev[pageIdx],
        [qId]: value
      }
    }));
  }, []);

  const refineCurrentPage = async () => {
    if (!currentPageIdx && currentPageIdx !== 0) return;
    
    // Get values directly from refs - no state needed
    const questions = contextQuestions[currentPageIdx]?.questions || [];
    const pageAnswers = {};
    
    questions.forEach(q => {
      const refKey = `${currentPageIdx}-${q.id}`;
      if (textareaRefs.current[refKey]) {
        pageAnswers[q.id] = textareaRefs.current[refKey].value;
      }
    });
    
    // Save to answers state
    setAnswers(prev => ({
      ...prev,
      [currentPageIdx]: pageAnswers
    }));
    
    setRefining(true);
    try {
      // Convert answers to format backend expects
      const answersArray = questions.map(q => ({
        question: q.question,
        answer: pageAnswers[q.id] || ''
      }));

      const r = await fetch(`${API}/discover/${discId}/refine-scenarios`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageIndex: currentPageIdx,
          answers: answersArray
        })
      });
      const d = await r.json();
      if (d.error) {
        setError(d.error);
        setRefining(false);
        return;
      }

      // Store refined scenarios
      setRefinedScenarios(prev => ({
        ...prev,
        [currentPageIdx]: d.refinedScenarios || []
      }));

      // Move to next page or complete
      const selectedArray = Array.from(selectedScreens);
      const currentIdx = selectedArray.indexOf(currentPageIdx);
      if (currentIdx < selectedArray.length - 1) {
        const nextPageIdx = selectedArray[currentIdx + 1];
        setCurrentPageIdx(nextPageIdx);
        // Clear old refs
        textareaRefs.current = {};
        setError('');
      } else {
        setStep('complete');
        setError('');
      }
    } catch (e) {
      setError(e.message);
    }
    setRefining(false);
  };

  const skipCurrentPage = () => {
    const selectedArray = Array.from(selectedScreens);
    const currentIdx = selectedArray.indexOf(currentPageIdx);
    if (currentIdx < selectedArray.length - 1) {
      const nextPageIdx = selectedArray[currentIdx + 1];
      setCurrentPageIdx(nextPageIdx);
    } else {
      setStep('complete');
    }
  };

  const proceedToTest = () => {
    onComplete();
  };

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════

  const wrap = {
    padding: '24px',
    fontFamily: '"Inter", sans-serif',
    background: '#f8fafc',
    borderRadius: '8px'
  };

  const Card = ({ title, children, mb = 0 }) => (
    <div style={{
      background: 'white',
      borderRadius: '8px',
      padding: '16px',
      marginBottom: mb,
      border: '1px solid #e2e8f0',
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
    }}>
      {title && <h3 style={{ margin: '0 0 12px 0', fontSize: 14, fontWeight: 600, color: '#1e293b' }}>{title}</h3>}
      {children}
    </div>
  );

  const Button = ({ children, onClick, primary = false, disabled = false, style = {} }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 16px',
        borderRadius: '6px',
        border: 'none',
        fontSize: '13px',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: primary ? '#6366f1' : '#e2e8f0',
        color: primary ? 'white' : '#1e293b',
        opacity: disabled ? 0.5 : 1,
        ...style
      }}
    >
      {children}
    </button>
  );

  // Loading state
  if (step === 'loading') {
    return (
      <div style={wrap}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
          <p>Loading context questions...</p>
          {error && <p style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>}
        </div>
      </div>
    );
  }

  // Answering questions
  if (step === 'answering' && currentPageIdx !== null && currentPageIdx !== undefined) {
    const pageQuestions = contextQuestions[currentPageIdx];
    if (!pageQuestions) {
      return (
        <div style={wrap}>
          <p style={{ color: '#dc2626' }}>Questions not found for this page</p>
          <Button onClick={() => skipCurrentPage()}>Skip</Button>
        </div>
      );
    }

    const screen = disc.screens[currentPageIdx];
    const selectedArray = Array.from(selectedScreens);
    const pageNum = selectedArray.indexOf(currentPageIdx) + 1;
    const totalPages = selectedArray.length;

    return (
      <div style={wrap}>
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 18, fontWeight: 700, color: '#1e293b' }}>
            ❓ Refine Scenarios
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
            Answer a few questions to make test scenarios more specific ({pageNum}/{totalPages})
          </p>
        </div>

        <Card title={`📄 ${screen?.title || 'Page'}`} mb={14}>
          <p style={{ margin: '0 0 12px 0', fontSize: 12, color: '#64748b', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {screen?.url}
          </p>
        </Card>

        <Card title="Questions" mb={14}>
          {pageQuestions.questions && pageQuestions.questions.map((q, qIndex) => (
            <div key={q.id} style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
                {q.question}
              </label>
              {q.hint && (
                <p style={{ margin: '0 0 6px 0', fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>
                  💡 {q.hint}
                </p>
              )}
              <textarea
                ref={el => {
                  if (el) textareaRefs.current[`${currentPageIdx}-${q.id}`] = el;
                }}
                autoFocus={qIndex === 0}
                placeholder={q.hint}
                style={{
                  width: '100%',
                  minHeight: '60px',
                  padding: '8px',
                  borderRadius: '4px',
                  border: '1px solid #cbd5e1',
                  fontFamily: '"Inter", sans-serif',
                  fontSize: '13px',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          ))}
        </Card>

        {error && (
          <Card style={{ background: '#fef2f2', borderColor: '#fecaca', marginBottom: 14 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#dc2626' }}>❌ {error}</p>
          </Card>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={refineCurrentPage}
            primary
            disabled={refining}
            style={{ flex: 1 }}
          >
            {refining ? '🔄 Refining...' : '→ Refine & Next'}
          </Button>
          <Button
            onClick={skipCurrentPage}
            disabled={refining}
          >
            Skip This Page
          </Button>
          <Button
            onClick={onCancel}
            disabled={refining}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // Complete state
  if (step === 'complete') {
    const completedCount = Object.keys(refinedScenarios).length;
    const totalPages = selectedScreens.size;

    return (
      <div style={wrap}>
        <div style={{ marginBottom: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: 18, fontWeight: 700, color: '#1e293b' }}>
            Scenario Refinement Complete
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
            {completedCount}/{totalPages} pages refined with context
          </p>
        </div>

        {completedCount > 0 && (
          <Card title="📊 Refined Scenarios" mb={14}>
            {Array.from(selectedScreens).map(idx => {
              const scenarios = refinedScenarios[idx];
              if (!scenarios) return null;
              const screen = disc.screens[idx];
              return (
                <div key={idx} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #e2e8f0' }}>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 12, fontWeight: 600, color: '#1e293b' }}>
                    {screen?.title}
                  </h4>
                  <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                    🎯 {scenarios.length} scenarios planned
                  </p>
                </div>
              );
            })}
          </Card>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={proceedToTest}
            primary
            style={{ flex: 1 }}
          >
            → Proceed to Testing
          </Button>
          <Button onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
