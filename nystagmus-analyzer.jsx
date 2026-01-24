import React, { useState, useCallback, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea, Brush } from 'recharts';
import { Upload, Trash2, Plus, Download, Eye, EyeOff, Settings, BarChart3, RefreshCw, Check, X, Edit3, FileText } from 'lucide-react';

// Slow phase detection algorithm using velocity thresholding
const detectSlowPhases = (data, params) => {
  if (!data || data.length < 3) return [];
  
  const { velocityThreshold, minDuration, smoothingWindow } = params;
  const phases = [];
  
  // Calculate velocities
  const velocities = [];
  for (let i = 1; i < data.length; i++) {
    const dt = data[i].time - data[i - 1].time;
    if (dt <= 0) continue;
    
    const vH = (data[i].horizontal - data[i - 1].horizontal) / dt;
    const vV = (data[i].vertical - data[i - 1].vertical) / dt;
    const speed = Math.sqrt(vH * vH + vV * vV);
    
    velocities.push({
      index: i,
      time: data[i].time,
      vH,
      vV,
      speed
    });
  }
  
  if (velocities.length === 0) return [];
  
  // Apply moving average smoothing
  const smoothed = [];
  const halfWindow = Math.floor(smoothingWindow / 2);
  for (let i = 0; i < velocities.length; i++) {
    let sumSpeed = 0;
    let count = 0;
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(velocities.length - 1, i + halfWindow); j++) {
      sumSpeed += velocities[j].speed;
      count++;
    }
    smoothed.push({
      ...velocities[i],
      smoothedSpeed: sumSpeed / count
    });
  }
  
  // Detect slow phases (below velocity threshold)
  // In nystagmus: slow phases are typically 5-100 deg/s, fast phases are 200-700+ deg/s
  let inSlowPhase = false;
  let phaseStart = null;
  
  for (let i = 0; i < smoothed.length; i++) {
    const isSlow = smoothed[i].smoothedSpeed < velocityThreshold;
    
    if (isSlow && !inSlowPhase) {
      inSlowPhase = true;
      phaseStart = i;
    } else if (!isSlow && inSlowPhase) {
      inSlowPhase = false;
      const duration = smoothed[i - 1].time - smoothed[phaseStart].time;
      
      if (duration >= minDuration) {
        let sumVH = 0, sumVV = 0;
        for (let j = phaseStart; j < i; j++) {
          sumVH += smoothed[j].vH;
          sumVV += smoothed[j].vV;
        }
        const avgVH = sumVH / (i - phaseStart);
        const avgVV = sumVV / (i - phaseStart);
        
        phases.push({
          id: `phase-${phases.length}-${Date.now()}`,
          startTime: smoothed[phaseStart].time,
          endTime: smoothed[i - 1].time,
          duration,
          avgHorizontalVelocity: avgVH,
          avgVerticalVelocity: avgVV,
          avgSpeed: Math.sqrt(avgVH * avgVH + avgVV * avgVV)
        });
      }
    }
  }
  
  // Handle ending in a slow phase
  if (inSlowPhase && phaseStart !== null) {
    const lastIdx = smoothed.length - 1;
    const duration = smoothed[lastIdx].time - smoothed[phaseStart].time;
    
    if (duration >= minDuration) {
      let sumVH = 0, sumVV = 0;
      for (let j = phaseStart; j <= lastIdx; j++) {
        sumVH += smoothed[j].vH;
        sumVV += smoothed[j].vV;
      }
      const avgVH = sumVH / (lastIdx - phaseStart + 1);
      const avgVV = sumVV / (lastIdx - phaseStart + 1);
      
      phases.push({
        id: `phase-${phases.length}-${Date.now()}`,
        startTime: smoothed[phaseStart].time,
        endTime: smoothed[lastIdx].time,
        duration,
        avgHorizontalVelocity: avgVH,
        avgVerticalVelocity: avgVV,
        avgSpeed: Math.sqrt(avgVH * avgVH + avgVV * avgVV)
      });
    }
  }
  
  return phases;
};

// Calculate velocity for a phase from raw data
const calculatePhaseVelocity = (data, startTime, endTime) => {
  const phaseData = data.filter(d => d.time >= startTime && d.time <= endTime);
  if (phaseData.length < 2) {
    return { avgHorizontalVelocity: 0, avgVerticalVelocity: 0, avgSpeed: 0 };
  }
  
  let sumVH = 0, sumVV = 0, count = 0;
  
  for (let i = 1; i < phaseData.length; i++) {
    const dt = phaseData[i].time - phaseData[i - 1].time;
    if (dt <= 0) continue;
    
    sumVH += (phaseData[i].horizontal - phaseData[i - 1].horizontal) / dt;
    sumVV += (phaseData[i].vertical - phaseData[i - 1].vertical) / dt;
    count++;
  }
  
  if (count === 0) return { avgHorizontalVelocity: 0, avgVerticalVelocity: 0, avgSpeed: 0 };
  
  const avgVH = sumVH / count;
  const avgVV = sumVV / count;
  
  return {
    avgHorizontalVelocity: avgVH,
    avgVerticalVelocity: avgVV,
    avgSpeed: Math.sqrt(avgVH * avgVH + avgVV * avgVV)
  };
};

// Custom tooltip for chart
const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div style={{
        background: 'rgba(15, 23, 42, 0.95)',
        border: '1px solid rgba(56, 189, 248, 0.3)',
        borderRadius: '8px',
        padding: '12px 16px',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '12px'
      }}>
        <p style={{ color: '#94a3b8', marginBottom: '8px' }}>Time: {typeof label === 'number' ? label.toFixed(4) : label}s</p>
        {payload.map((entry, index) => (
          <p key={index} style={{ color: entry.color, margin: '4px 0' }}>
            {entry.name}: {typeof entry.value === 'number' ? entry.value.toFixed(2) : entry.value}°
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function NystagmusAnalyzer() {
  const [data, setData] = useState([]);
  const [slowPhases, setSlowPhases] = useState([]);
  const [selectedPhase, setSelectedPhase] = useState(null);
  const [isAddingPhase, setIsAddingPhase] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHorizontal, setShowHorizontal] = useState(true);
  const [showVertical, setShowVertical] = useState(true);
  const [fileName, setFileName] = useState('');
  const [editingPhase, setEditingPhase] = useState(null);
  const [tempEditValues, setTempEditValues] = useState({ startTime: '', endTime: '' });
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [selectedEye, setSelectedEye] = useState('right');
  const [availableEyes, setAvailableEyes] = useState({ right: false, left: false });
  const [rawData, setRawData] = useState(null);
  
  // Increased default velocity threshold to 150 deg/s
  // Typical slow phase: 5-100 deg/s, fast phase: 200-700+ deg/s
  const [detectionParams, setDetectionParams] = useState({
    velocityThreshold: 150,
    minDuration: 0.04,
    smoothingWindow: 5
  });
  
  const fileInputRef = useRef(null);

  // Parse CSV file with new column format
  const parseCSV = useCallback((text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    
    // Parse headers - handle potential whitespace and case variations
    const headers = lines[0].split(',').map(h => h.trim());
    const headersLower = headers.map(h => h.toLowerCase());
    
    // Find column indices for the expected format
    const timeIdx = headersLower.findIndex(h => h === 'time' || h === 't');
    const rightXIdx = headersLower.findIndex(h => h === 'righteyex' || h === 'right_eye_x' || h === 'righteye_x');
    const rightYIdx = headersLower.findIndex(h => h === 'righteyey' || h === 'right_eye_y' || h === 'righteye_y');
    const leftXIdx = headersLower.findIndex(h => h === 'lefteyex' || h === 'left_eye_x' || h === 'lefteye_x');
    const leftYIdx = headersLower.findIndex(h => h === 'lefteyey' || h === 'left_eye_y' || h === 'lefteye_y');
    
    if (timeIdx === -1) {
      alert('CSV must contain a Time column');
      return null;
    }
    
    const hasRight = rightXIdx !== -1 && rightYIdx !== -1;
    const hasLeft = leftXIdx !== -1 && leftYIdx !== -1;
    
    if (!hasRight && !hasLeft) {
      alert('CSV must contain eye position columns.\n\nExpected columns: RightEyeX, RightEyeY and/or LeftEyeX, LeftEyeY');
      return null;
    }
    
    const parsedData = {
      right: [],
      left: [],
      hasRight,
      hasLeft
    };
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values = line.split(',').map(v => parseFloat(v.trim()));
      const time = values[timeIdx];
      
      if (isNaN(time)) continue;
      
      if (hasRight) {
        const rightX = values[rightXIdx];
        const rightY = values[rightYIdx];
        if (!isNaN(rightX) && !isNaN(rightY)) {
          parsedData.right.push({
            time,
            horizontal: rightX,
            vertical: rightY
          });
        }
      }
      
      if (hasLeft) {
        const leftX = values[leftXIdx];
        const leftY = values[leftYIdx];
        if (!isNaN(leftX) && !isNaN(leftY)) {
          parsedData.left.push({
            time,
            horizontal: leftX,
            vertical: leftY
          });
        }
      }
    }
    
    // Sort by time
    parsedData.right.sort((a, b) => a.time - b.time);
    parsedData.left.sort((a, b) => a.time - b.time);
    
    return parsedData;
  }, []);

  // Handle file upload
  const handleFileUpload = useCallback((event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result);
      if (!parsed) return;
      
      setRawData(parsed);
      setAvailableEyes({ right: parsed.hasRight, left: parsed.hasLeft });
      
      // Select first available eye
      const eye = parsed.hasRight ? 'right' : 'left';
      setSelectedEye(eye);
      
      const eyeData = parsed[eye];
      setData(eyeData);
      setSelectedPhase(null);
      setEditingPhase(null);
      
      if (eyeData.length > 0) {
        const detected = detectSlowPhases(eyeData, detectionParams);
        setSlowPhases(detected);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }, [parseCSV, detectionParams]);

  // Handle eye selection change
  const handleEyeChange = useCallback((eye) => {
    if (!rawData || !rawData[eye] || rawData[eye].length === 0) return;
    
    setSelectedEye(eye);
    const eyeData = rawData[eye];
    setData(eyeData);
    setSelectedPhase(null);
    setEditingPhase(null);
    
    const detected = detectSlowPhases(eyeData, detectionParams);
    setSlowPhases(detected);
  }, [rawData, detectionParams]);

  // Recalculate slow phases with current parameters
  const recalculatePhases = useCallback(() => {
    if (data.length > 0) {
      const detected = detectSlowPhases(data, detectionParams);
      setSlowPhases(detected);
      setSelectedPhase(null);
      setEditingPhase(null);
    }
  }, [data, detectionParams]);

  // Calculate statistics
  const statistics = useMemo(() => {
    if (slowPhases.length === 0) {
      return {
        count: 0,
        avgHorizontalVelocity: 0,
        avgVerticalVelocity: 0,
        avgSpeed: 0,
        totalDuration: 0,
        stdSpeed: 0
      };
    }
    
    const speeds = slowPhases.map(p => p.avgSpeed);
    const sumH = slowPhases.reduce((acc, p) => acc + p.avgHorizontalVelocity, 0);
    const sumV = slowPhases.reduce((acc, p) => acc + p.avgVerticalVelocity, 0);
    const sumSpeed = speeds.reduce((acc, s) => acc + s, 0);
    const totalDuration = slowPhases.reduce((acc, p) => acc + p.duration, 0);
    
    const avgSpeed = sumSpeed / slowPhases.length;
    const variance = speeds.reduce((acc, s) => acc + Math.pow(s - avgSpeed, 2), 0) / slowPhases.length;
    
    return {
      count: slowPhases.length,
      avgHorizontalVelocity: sumH / slowPhases.length,
      avgVerticalVelocity: sumV / slowPhases.length,
      avgSpeed,
      totalDuration,
      stdSpeed: Math.sqrt(variance)
    };
  }, [slowPhases]);

  // Handle mouse down on chart for adding phases
  const handleMouseDown = useCallback((e) => {
    if (!isAddingPhase || !e?.activeLabel) return;
    setDragStart(e.activeLabel);
    setDragEnd(e.activeLabel);
  }, [isAddingPhase]);

  // Handle mouse move on chart
  const handleMouseMove = useCallback((e) => {
    if (!isAddingPhase || dragStart === null || !e?.activeLabel) return;
    setDragEnd(e.activeLabel);
  }, [isAddingPhase, dragStart]);

  // Handle mouse up on chart
  const handleMouseUp = useCallback(() => {
    if (!isAddingPhase || dragStart === null || dragEnd === null) return;
    
    const startTime = Math.min(dragStart, dragEnd);
    const endTime = Math.max(dragStart, dragEnd);
    
    if (endTime - startTime < 0.001) {
      setDragStart(null);
      setDragEnd(null);
      return;
    }
    
    const velocities = calculatePhaseVelocity(data, startTime, endTime);
    
    const newPhase = {
      id: `phase-manual-${Date.now()}`,
      startTime,
      endTime,
      duration: endTime - startTime,
      ...velocities
    };
    
    setSlowPhases(prev => [...prev, newPhase].sort((a, b) => a.startTime - b.startTime));
    setDragStart(null);
    setDragEnd(null);
    setIsAddingPhase(false);
  }, [isAddingPhase, dragStart, dragEnd, data]);

  // Delete a phase
  const deletePhase = useCallback((id, e) => {
    e?.stopPropagation();
    setSlowPhases(prev => prev.filter(p => p.id !== id));
    if (selectedPhase === id) setSelectedPhase(null);
    if (editingPhase === id) setEditingPhase(null);
  }, [selectedPhase, editingPhase]);

  // Start editing a phase
  const startEditingPhase = useCallback((phase, e) => {
    e?.stopPropagation();
    setEditingPhase(phase.id);
    setTempEditValues({
      startTime: phase.startTime.toFixed(4),
      endTime: phase.endTime.toFixed(4)
    });
  }, []);

  // Save edited phase
  const saveEditedPhase = useCallback((e) => {
    e?.stopPropagation();
    if (!editingPhase) return;
    
    const startTime = parseFloat(tempEditValues.startTime);
    const endTime = parseFloat(tempEditValues.endTime);
    
    if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
      alert('Invalid time values. End time must be greater than start time.');
      return;
    }
    
    const velocities = calculatePhaseVelocity(data, startTime, endTime);
    
    setSlowPhases(prev => prev.map(p => {
      if (p.id === editingPhase) {
        return {
          ...p,
          startTime,
          endTime,
          duration: endTime - startTime,
          ...velocities
        };
      }
      return p;
    }).sort((a, b) => a.startTime - b.startTime));
    
    setEditingPhase(null);
  }, [editingPhase, tempEditValues, data]);

  // Cancel editing
  const cancelEditing = useCallback((e) => {
    e?.stopPropagation();
    setEditingPhase(null);
  }, []);

  // Export as JSON
  const exportJSON = useCallback(() => {
    const exportObj = {
      fileName,
      selectedEye,
      exportDate: new Date().toISOString(),
      detectionParameters: detectionParams,
      statistics: {
        numberOfSlowPhases: statistics.count,
        averageHorizontalVelocity_degPerSec: statistics.avgHorizontalVelocity,
        averageVerticalVelocity_degPerSec: statistics.avgVerticalVelocity,
        averageSlowPhaseVelocity_degPerSec: statistics.avgSpeed,
        standardDeviation_degPerSec: statistics.stdSpeed,
        totalSlowPhaseDuration_sec: statistics.totalDuration
      },
      slowPhases: slowPhases.map(p => ({
        startTime_sec: p.startTime,
        endTime_sec: p.endTime,
        duration_sec: p.duration,
        horizontalVelocity_degPerSec: p.avgHorizontalVelocity,
        verticalVelocity_degPerSec: p.avgVerticalVelocity,
        speed_degPerSec: p.avgSpeed
      })),
      rawDataPoints: data.length
    };
    
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nystagmus-analysis-${selectedEye}-${fileName.replace('.csv', '')}-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName, selectedEye, detectionParams, statistics, slowPhases, data]);

  // Export as CSV
  const exportCSV = useCallback(() => {
    const headers = ['Phase #', 'Start Time (s)', 'End Time (s)', 'Duration (s)', 'Horizontal Velocity (°/s)', 'Vertical Velocity (°/s)', 'Speed (°/s)'];
    const rows = slowPhases.map((p, i) => [
      i + 1,
      p.startTime.toFixed(4),
      p.endTime.toFixed(4),
      p.duration.toFixed(4),
      p.avgHorizontalVelocity.toFixed(3),
      p.avgVerticalVelocity.toFixed(3),
      p.avgSpeed.toFixed(3)
    ]);
    
    // Add summary rows
    rows.push([]);
    rows.push(['Summary Statistics']);
    rows.push(['Eye', selectedEye.charAt(0).toUpperCase() + selectedEye.slice(1)]);
    rows.push(['Total Slow Phases', statistics.count]);
    rows.push(['Average Horizontal Velocity (°/s)', statistics.avgHorizontalVelocity.toFixed(3)]);
    rows.push(['Average Vertical Velocity (°/s)', statistics.avgVerticalVelocity.toFixed(3)]);
    rows.push(['Average Slow Phase Velocity (°/s)', statistics.avgSpeed.toFixed(3)]);
    rows.push(['Standard Deviation (°/s)', statistics.stdSpeed.toFixed(3)]);
    rows.push(['Total Slow Phase Duration (s)', statistics.totalDuration.toFixed(4)]);
    
    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slow-phases-${selectedEye}-${fileName.replace('.csv', '')}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [slowPhases, fileName, selectedEye, statistics]);

  // Chart data with downsampling for performance
  const chartData = useMemo(() => {
    if (data.length <= 2000) return data;
    const step = Math.ceil(data.length / 2000);
    return data.filter((_, i) => i % step === 0);
  }, [data]);

  // Position range for Y axis
  const positionRange = useMemo(() => {
    if (data.length === 0) return { min: -10, max: 10 };
    let minH = Infinity, maxH = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    
    data.forEach(d => {
      if (d.horizontal < minH) minH = d.horizontal;
      if (d.horizontal > maxH) maxH = d.horizontal;
      if (d.vertical < minV) minV = d.vertical;
      if (d.vertical > maxV) maxV = d.vertical;
    });
    
    const min = Math.min(minH, minV);
    const max = Math.max(maxH, maxV);
    const padding = (max - min) * 0.1 || 1;
    
    return { min: min - padding, max: max + padding };
  }, [data]);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
      fontFamily: "'DM Sans', -apple-system, sans-serif",
      color: '#e2e8f0'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        .panel {
          background: rgba(30, 41, 59, 0.8);
          border: 1px solid rgba(148, 163, 184, 0.1);
          border-radius: 16px;
          backdrop-filter: blur(12px);
        }
        
        .panel-glow {
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(56, 189, 248, 0.05);
        }
        
        .stat-card {
          background: linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(56, 189, 248, 0.02) 100%);
          border: 1px solid rgba(56, 189, 248, 0.15);
          border-radius: 12px;
          padding: 20px;
          transition: all 0.3s ease;
        }
        
        .stat-card:hover {
          border-color: rgba(56, 189, 248, 0.3);
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(56, 189, 248, 0.1);
        }
        
        .stat-value {
          font-family: 'JetBrains Mono', monospace;
          font-size: 28px;
          font-weight: 600;
          color: #38bdf8;
          line-height: 1;
        }
        
        .stat-label {
          font-size: 13px;
          color: #94a3b8;
          margin-top: 8px;
          font-weight: 500;
        }
        
        .btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 18px;
          border-radius: 10px;
          font-family: inherit;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          border: none;
        }
        
        .btn-primary {
          background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
          color: #0f172a;
        }
        
        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 16px rgba(56, 189, 248, 0.4);
        }
        
        .btn-secondary {
          background: rgba(148, 163, 184, 0.1);
          color: #94a3b8;
          border: 1px solid rgba(148, 163, 184, 0.2);
        }
        
        .btn-secondary:hover {
          background: rgba(148, 163, 184, 0.2);
          color: #e2e8f0;
        }
        
        .btn-success {
          background: rgba(34, 197, 94, 0.15);
          color: #22c55e;
          border: 1px solid rgba(34, 197, 94, 0.3);
        }
        
        .btn-success:hover {
          background: rgba(34, 197, 94, 0.25);
        }
        
        .btn-success.active {
          background: rgba(34, 197, 94, 0.3);
          border-color: #22c55e;
        }
        
        .btn-danger {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.2);
          padding: 6px 10px;
        }
        
        .btn-danger:hover {
          background: rgba(239, 68, 68, 0.2);
        }
        
        .btn-icon {
          padding: 8px;
          border-radius: 8px;
        }
        
        .phase-row {
          display: grid;
          grid-template-columns: 50px 1fr 1fr 1fr 1fr 80px;
          gap: 12px;
          padding: 14px 16px;
          align-items: center;
          border-bottom: 1px solid rgba(148, 163, 184, 0.08);
          transition: all 0.2s ease;
          cursor: pointer;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
        }
        
        .phase-row:hover {
          background: rgba(56, 189, 248, 0.05);
        }
        
        .phase-row.selected {
          background: rgba(56, 189, 248, 0.1);
          border-left: 3px solid #38bdf8;
          margin-left: -3px;
        }
        
        .phase-row.editing {
          background: rgba(251, 191, 36, 0.1);
          border-left: 3px solid #fbbf24;
          margin-left: -3px;
        }
        
        .input-field {
          background: rgba(15, 23, 42, 0.8);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 8px;
          padding: 10px 14px;
          color: #e2e8f0;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          width: 100%;
          transition: all 0.2s ease;
        }
        
        .input-field:focus {
          outline: none;
          border-color: #38bdf8;
          box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.1);
        }
        
        .upload-zone {
          border: 2px dashed rgba(56, 189, 248, 0.3);
          border-radius: 16px;
          padding: 60px 40px;
          text-align: center;
          cursor: pointer;
          transition: all 0.3s ease;
          background: rgba(56, 189, 248, 0.02);
        }
        
        .upload-zone:hover {
          border-color: #38bdf8;
          background: rgba(56, 189, 248, 0.05);
        }
        
        .toggle-group {
          display: flex;
          gap: 8px;
        }
        
        .toggle-btn {
          padding: 8px 14px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.2);
          background: transparent;
          color: #64748b;
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        
        .toggle-btn.active {
          background: rgba(56, 189, 248, 0.15);
          color: #38bdf8;
          border-color: rgba(56, 189, 248, 0.4);
        }
        
        .toggle-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        
        .eye-selector {
          display: flex;
          gap: 8px;
        }
        
        .eye-btn {
          padding: 8px 16px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.2);
          background: transparent;
          color: #64748b;
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          transition: all 0.2s ease;
        }
        
        .eye-btn.active {
          background: rgba(56, 189, 248, 0.15);
          color: #38bdf8;
          border-color: rgba(56, 189, 248, 0.4);
        }
        
        .eye-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        
        .phase-list {
          max-height: 320px;
          overflow-y: auto;
        }
        
        .phase-list::-webkit-scrollbar {
          width: 6px;
        }
        
        .phase-list::-webkit-scrollbar-track {
          background: rgba(148, 163, 184, 0.05);
          border-radius: 3px;
        }
        
        .phase-list::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.2);
          border-radius: 3px;
        }
        
        .phase-list::-webkit-scrollbar-thumb:hover {
          background: rgba(148, 163, 184, 0.3);
        }
        
        .header-row {
          display: grid;
          grid-template-columns: 50px 1fr 1fr 1fr 1fr 80px;
          gap: 12px;
          padding: 12px 16px;
          background: rgba(15, 23, 42, 0.5);
          border-bottom: 1px solid rgba(148, 163, 184, 0.1);
          font-size: 11px;
          font-weight: 600;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .settings-panel {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          padding: 20px;
          background: rgba(15, 23, 42, 0.5);
          border-radius: 12px;
          margin-bottom: 20px;
        }
        
        .settings-field label {
          display: block;
          font-size: 12px;
          color: #94a3b8;
          margin-bottom: 8px;
          font-weight: 500;
        }
        
        .hint-text {
          font-size: 11px;
          color: #64748b;
          margin-top: 4px;
        }
        
        .badge {
          display: inline-flex;
          align-items: center;
          padding: 4px 10px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
        }
        
        .badge-info {
          background: rgba(56, 189, 248, 0.15);
          color: #38bdf8;
        }
        
        .instructions {
          background: rgba(251, 191, 36, 0.1);
          border: 1px solid rgba(251, 191, 36, 0.2);
          border-radius: 10px;
          padding: 14px 18px;
          font-size: 13px;
          color: #fbbf24;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .action-btns {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
        }
        
        .format-hint {
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.2);
          border-radius: 8px;
          padding: 16px 20px;
          margin-top: 24px;
          font-size: 13px;
        }
        
        .format-hint code {
          background: rgba(15, 23, 42, 0.6);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: #38bdf8;
        }
      `}</style>

      {/* Header */}
      <header style={{ 
        padding: '24px 32px', 
        borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        background: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(12px)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: '1600px', margin: '0 auto' }}>
          <div>
            <h1 style={{ 
              fontSize: '24px', 
              fontWeight: '700', 
              color: '#f8fafc',
              display: 'flex',
              alignItems: 'center',
              gap: '12px'
            }}>
              <BarChart3 size={28} style={{ color: '#38bdf8' }} />
              Nystagmus Velocity Analyzer
            </h1>
            {fileName && (
              <p style={{ fontSize: '14px', color: '#64748b', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={14} />
                {fileName} • {data.length.toLocaleString()} samples • {selectedEye.charAt(0).toUpperCase() + selectedEye.slice(1)} Eye
              </p>
            )}
          </div>
          
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            {data.length > 0 && (
              <div className="eye-selector">
                <button 
                  className={`eye-btn ${selectedEye === 'right' ? 'active' : ''}`}
                  onClick={() => handleEyeChange('right')}
                  disabled={!availableEyes.right}
                >
                  Right Eye
                </button>
                <button 
                  className={`eye-btn ${selectedEye === 'left' ? 'active' : ''}`}
                  onClick={() => handleEyeChange('left')}
                  disabled={!availableEyes.left}
                >
                  Left Eye
                </button>
              </div>
            )}
            
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <button 
              className="btn btn-primary"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={18} />
              Upload CSV
            </button>
            
            {data.length > 0 && (
              <>
                <button 
                  className="btn btn-secondary"
                  onClick={() => setShowSettings(!showSettings)}
                >
                  <Settings size={18} />
                  Settings
                </button>
                <button className="btn btn-secondary" onClick={exportCSV}>
                  <Download size={18} />
                  CSV
                </button>
                <button className="btn btn-secondary" onClick={exportJSON}>
                  <Download size={18} />
                  JSON
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main style={{ padding: '32px', maxWidth: '1600px', margin: '0 auto' }}>
        {data.length === 0 ? (
          /* Upload Zone */
          <div 
            className="upload-zone"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={56} style={{ color: '#38bdf8', marginBottom: '20px' }} />
            <h2 style={{ fontSize: '20px', fontWeight: '600', color: '#f8fafc', marginBottom: '12px' }}>
              Upload Eye Movement Recording
            </h2>
            <p style={{ color: '#94a3b8', maxWidth: '500px', margin: '0 auto', lineHeight: '1.6' }}>
              Select a CSV file containing eye tracking data. The algorithm will automatically detect slow phases of nystagmus.
            </p>
            
            <div className="format-hint">
              <p style={{ color: '#94a3b8', marginBottom: '8px' }}><strong style={{ color: '#f8fafc' }}>Expected CSV format:</strong></p>
              <p style={{ color: '#64748b' }}>
                Required columns: <code>Time</code>, <code>RightEyeX</code>, <code>RightEyeY</code> and/or <code>LeftEyeX</code>, <code>LeftEyeY</code>
              </p>
              <p style={{ color: '#64748b', marginTop: '8px' }}>
                Optional columns: <code>RightEyeZ</code>, <code>LeftEyeZ</code> (will be ignored)
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Detection Settings Panel */}
            {showSettings && (
              <div className="panel panel-glow" style={{ marginBottom: '24px', padding: '24px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Settings size={18} style={{ color: '#38bdf8' }} />
                  Detection Parameters
                </h3>
                <div className="settings-panel">
                  <div className="settings-field">
                    <label>Velocity Threshold (°/s)</label>
                    <input
                      type="number"
                      className="input-field"
                      value={detectionParams.velocityThreshold}
                      onChange={(e) => setDetectionParams(prev => ({ ...prev, velocityThreshold: parseFloat(e.target.value) || 0 }))}
                    />
                    <p className="hint-text">Movements below this speed are slow phases (typical: 100-200)</p>
                  </div>
                  <div className="settings-field">
                    <label>Minimum Duration (s)</label>
                    <input
                      type="number"
                      step="0.01"
                      className="input-field"
                      value={detectionParams.minDuration}
                      onChange={(e) => setDetectionParams(prev => ({ ...prev, minDuration: parseFloat(e.target.value) || 0 }))}
                    />
                    <p className="hint-text">Minimum duration for a valid slow phase</p>
                  </div>
                  <div className="settings-field">
                    <label>Smoothing Window (samples)</label>
                    <input
                      type="number"
                      className="input-field"
                      value={detectionParams.smoothingWindow}
                      onChange={(e) => setDetectionParams(prev => ({ ...prev, smoothingWindow: parseInt(e.target.value) || 1 }))}
                    />
                    <p className="hint-text">Moving average window for velocity smoothing</p>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={recalculatePhases}>
                  <RefreshCw size={16} />
                  Recalculate Slow Phases
                </button>
              </div>
            )}

            {/* Statistics Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px', marginBottom: '24px' }}>
              <div className="stat-card">
                <div className="stat-value">{statistics.count}</div>
                <div className="stat-label">Slow Phases</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{statistics.avgSpeed.toFixed(1)}</div>
                <div className="stat-label">Avg Velocity (°/s)</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{statistics.avgHorizontalVelocity.toFixed(1)}</div>
                <div className="stat-label">Avg H Velocity (°/s)</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{statistics.avgVerticalVelocity.toFixed(1)}</div>
                <div className="stat-label">Avg V Velocity (°/s)</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">±{statistics.stdSpeed.toFixed(1)}</div>
                <div className="stat-label">Std Deviation (°/s)</div>
              </div>
            </div>

            {/* Chart Panel */}
            <div className="panel panel-glow" style={{ padding: '24px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <Eye size={18} style={{ color: '#38bdf8' }} />
                  Eye Position Over Time ({selectedEye.charAt(0).toUpperCase() + selectedEye.slice(1)} Eye)
                </h3>
                
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                  <div className="toggle-group">
                    <button 
                      className={`toggle-btn ${showHorizontal ? 'active' : ''}`}
                      onClick={() => setShowHorizontal(!showHorizontal)}
                    >
                      {showHorizontal ? <Eye size={14} /> : <EyeOff size={14} />}
                      Horizontal (X)
                    </button>
                    <button 
                      className={`toggle-btn ${showVertical ? 'active' : ''}`}
                      onClick={() => setShowVertical(!showVertical)}
                    >
                      {showVertical ? <Eye size={14} /> : <EyeOff size={14} />}
                      Vertical (Y)
                    </button>
                  </div>
                  
                  <button 
                    className={`btn ${isAddingPhase ? 'btn-success active' : 'btn-success'}`}
                    onClick={() => {
                      setIsAddingPhase(!isAddingPhase);
                      setDragStart(null);
                      setDragEnd(null);
                    }}
                  >
                    <Plus size={16} />
                    {isAddingPhase ? 'Click & Drag on Chart' : 'Add Phase'}
                  </button>
                </div>
              </div>

              {isAddingPhase && (
                <div className="instructions">
                  <Plus size={18} />
                  Click and drag on the chart to select a time range for the new slow phase. Click the button again to cancel.
                </div>
              )}

              <div style={{ height: '400px', cursor: isAddingPhase ? 'crosshair' : 'default' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={() => {
                      if (isAddingPhase && dragStart !== null) {
                        handleMouseUp();
                      }
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.1)" />
                    <XAxis 
                      dataKey="time" 
                      stroke="#64748b"
                      tick={{ fill: '#64748b', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
                      tickFormatter={(v) => v.toFixed(2)}
                      label={{ value: 'Time (s)', position: 'bottom', fill: '#64748b', fontSize: 12 }}
                    />
                    <YAxis 
                      stroke="#64748b"
                      tick={{ fill: '#64748b', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}
                      domain={[positionRange.min, positionRange.max]}
                      label={{ value: 'Position (°)', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 12 }}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    
                    {/* Slow phase highlights */}
                    {slowPhases.map((phase) => (
                      <ReferenceArea
                        key={phase.id}
                        x1={phase.startTime}
                        x2={phase.endTime}
                        fill={selectedPhase === phase.id ? "rgba(56, 189, 248, 0.25)" : "rgba(34, 197, 94, 0.15)"}
                        stroke={selectedPhase === phase.id ? "#38bdf8" : "#22c55e"}
                        strokeWidth={selectedPhase === phase.id ? 2 : 1}
                        strokeDasharray="3 3"
                      />
                    ))}
                    
                    {/* Drag selection preview */}
                    {isAddingPhase && dragStart !== null && dragEnd !== null && (
                      <ReferenceArea
                        x1={Math.min(dragStart, dragEnd)}
                        x2={Math.max(dragStart, dragEnd)}
                        fill="rgba(251, 191, 36, 0.2)"
                        stroke="#fbbf24"
                        strokeWidth={2}
                      />
                    )}
                    
                    {showHorizontal && (
                      <Line 
                        type="monotone" 
                        dataKey="horizontal" 
                        stroke="#38bdf8" 
                        dot={false} 
                        strokeWidth={1.5}
                        name="Horizontal (X)"
                        isAnimationActive={false}
                      />
                    )}
                    {showVertical && (
                      <Line 
                        type="monotone" 
                        dataKey="vertical" 
                        stroke="#f472b6" 
                        dot={false} 
                        strokeWidth={1.5}
                        name="Vertical (Y)"
                        isAnimationActive={false}
                      />
                    )}
                    
                    <Brush 
                      dataKey="time" 
                      height={40} 
                      stroke="rgba(56, 189, 248, 0.5)"
                      fill="rgba(15, 23, 42, 0.8)"
                      tickFormatter={(v) => v.toFixed(2)}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              
              <div style={{ display: 'flex', gap: '24px', marginTop: '16px', fontSize: '13px', color: '#94a3b8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '24px', height: '3px', background: '#38bdf8', borderRadius: '2px' }} />
                  Horizontal (X)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '24px', height: '3px', background: '#f472b6', borderRadius: '2px' }} />
                  Vertical (Y)
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div style={{ width: '24px', height: '12px', background: 'rgba(34, 197, 94, 0.3)', border: '1px dashed #22c55e', borderRadius: '2px' }} />
                  Slow Phase
                </div>
              </div>
            </div>

            {/* Slow Phases List */}
            <div className="panel panel-glow">
              <div style={{ padding: '20px 24px', borderBottom: '1px solid rgba(148, 163, 184, 0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '16px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  Detected Slow Phases
                  <span className="badge badge-info">{slowPhases.length}</span>
                </h3>
              </div>
              
              <div className="header-row">
                <div>#</div>
                <div>Start (s)</div>
                <div>End (s)</div>
                <div>Duration (s)</div>
                <div>Speed (°/s)</div>
                <div>Actions</div>
              </div>
              
              <div className="phase-list">
                {slowPhases.length === 0 ? (
                  <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                    No slow phases detected. Try adjusting the detection parameters (increase velocity threshold).
                  </div>
                ) : (
                  slowPhases.map((phase, index) => (
                    <div
                      key={phase.id}
                      className={`phase-row ${selectedPhase === phase.id ? 'selected' : ''} ${editingPhase === phase.id ? 'editing' : ''}`}
                      onClick={() => setSelectedPhase(selectedPhase === phase.id ? null : phase.id)}
                    >
                      <div style={{ color: '#64748b', fontWeight: '500' }}>{index + 1}</div>
                      
                      {editingPhase === phase.id ? (
                        <>
                          <div>
                            <input
                              type="text"
                              className="input-field"
                              value={tempEditValues.startTime}
                              onChange={(e) => setTempEditValues(prev => ({ ...prev, startTime: e.target.value }))}
                              onClick={(e) => e.stopPropagation()}
                              style={{ padding: '6px 10px' }}
                            />
                          </div>
                          <div>
                            <input
                              type="text"
                              className="input-field"
                              value={tempEditValues.endTime}
                              onChange={(e) => setTempEditValues(prev => ({ ...prev, endTime: e.target.value }))}
                              onClick={(e) => e.stopPropagation()}
                              style={{ padding: '6px 10px' }}
                            />
                          </div>
                          <div style={{ color: '#94a3b8' }}>—</div>
                          <div style={{ color: '#94a3b8' }}>—</div>
                          <div className="action-btns">
                            <button 
                              className="btn btn-icon btn-success" 
                              onClick={saveEditedPhase}
                              title="Save"
                            >
                              <Check size={14} />
                            </button>
                            <button 
                              className="btn btn-icon btn-danger" 
                              onClick={cancelEditing}
                              title="Cancel"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>{phase.startTime.toFixed(4)}</div>
                          <div>{phase.endTime.toFixed(4)}</div>
                          <div style={{ color: '#94a3b8' }}>{phase.duration.toFixed(4)}</div>
                          <div style={{ color: '#38bdf8', fontWeight: '500' }}>{phase.avgSpeed.toFixed(2)}</div>
                          <div className="action-btns">
                            <button 
                              className="btn btn-icon btn-secondary" 
                              onClick={(e) => startEditingPhase(phase, e)}
                              title="Edit"
                            >
                              <Edit3 size={14} />
                            </button>
                            <button 
                              className="btn btn-icon btn-danger" 
                              onClick={(e) => deletePhase(phase.id, e)}
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* Footer */}
      <footer style={{ 
        padding: '20px 32px', 
        borderTop: '1px solid rgba(148, 163, 184, 0.1)',
        textAlign: 'center',
        color: '#64748b',
        fontSize: '13px'
      }}>
        Nystagmus Velocity Analyzer • All processing is done locally in your browser
      </footer>
    </div>
  );
}
