import { useState } from 'react'
import { AnimatedAiAssistantButton } from './AnimatedAiAssistantButton'

function App() {
    const [isOpen, setIsOpen] = useState(false);
    const [isThinking, setIsThinking] = useState(false);

    const bgShells = [
        { name: 'Checkerboard', style: { backgroundImage: 'conic-gradient(#ccc 25%, #fff 25% 50%, #ccc 50% 75%, #fff 75%)', backgroundSize: '20px 20px' } },
        { name: 'White', style: { backgroundColor: '#ffffff' } },
        { name: 'App Dark (#13181C)', style: { backgroundColor: '#13181C' } },
        { name: 'Light Grey', style: { backgroundColor: '#e2e8f0' } }
    ];

    return (
        <div style={{ padding: '24px', color: '#f3f4f6', fontFamily: 'sans-serif', backgroundColor: '#0f172a', minHeight: '100vh' }}>
            <h1 style={{ margin: '0 0 10px 0', fontSize: '24px', fontWeight: 'bold' }}>AI Bot Redesign - Animation & Transparency Grid</h1>
            <p style={{ margin: '0 0 24px 0', color: '#9ca3af', fontSize: '14px' }}>
                Verify background removal, horizontal mirroring, neutral frontal leveling, and asset consistency across WebM, WebP, and Poster formats.
            </p>

            <div style={{ marginBottom: '24px', display: 'flex', gap: '12px' }}>
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    style={{ padding: '8px 16px', background: '#3b82f6', border: 'none', color: 'white', borderRadius: '6px', fontWeight: '500', cursor: 'pointer' }}
                >
                    Toggle Open Ring ({isOpen ? 'ON' : 'OFF'})
                </button>
                <button
                    onClick={() => setIsThinking(!isThinking)}
                    style={{ padding: '8px 16px', background: '#10b981', border: 'none', color: 'white', borderRadius: '6px', fontWeight: '500', cursor: 'pointer' }}
                >
                    Toggle Thinking Spin ({isThinking ? 'ON' : 'OFF'})
                </button>
            </div>

            {/* Test Matrix */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

                {/* Row 1: WebM Video */}
                <div>
                    <h2 style={{ fontSize: '16px', margin: '0 0 12px 0', color: '#60a5fa' }}>Format: WebM Video (Looping, Transparent, Mirrored, Level Face)</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                        {bgShells.map((bg) => (
                            <div key={bg.name} style={{ border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                                <div style={{ padding: '6px 12px', background: '#1e293b', fontSize: '12px', fontWeight: 'bold', color: '#94a3b8' }}>{bg.name}</div>
                                <div style={{ ...bg.style, padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
                                    {/* 88px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>88px (1x)</span>
                                        <div style={{ width: '88px', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <video autoPlay loop muted playsInline style={{ width: '130%', height: '130%', objectFit: 'contain' }}>
                                                <source src="/ai-assistant/ai-robot-loop.webm" type="video/webm" />
                                            </video>
                                        </div>
                                    </div>
                                    {/* 352px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>352px (4x)</span>
                                        <div style={{ width: '352px', height: '352px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <video autoPlay loop muted playsInline style={{ width: '100%', height: '100%', objectFit: 'contain' }}>
                                                <source src="/ai-assistant/ai-robot-loop.webm" type="video/webm" />
                                            </video>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Row 2: Animated WebP */}
                <div>
                    <h2 style={{ fontSize: '16px', margin: '0 0 12px 0', color: '#34d399' }}>Format: Animated WebP (Looping Fallback, Transparent, Mirrored, Level Face)</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                        {bgShells.map((bg) => (
                            <div key={bg.name} style={{ border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                                <div style={{ padding: '6px 12px', background: '#1e293b', fontSize: '12px', fontWeight: 'bold', color: '#94a3b8' }}>{bg.name}</div>
                                <div style={{ ...bg.style, padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
                                    {/* 88px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>88px (1x)</span>
                                        <div style={{ width: '88px', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <img src="/ai-assistant/ai-robot-loop.webp" alt="WebP 1x" style={{ width: '130%', height: '130%', objectFit: 'contain' }} />
                                        </div>
                                    </div>
                                    {/* 352px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>352px (4x)</span>
                                        <div style={{ width: '352px', height: '352px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <img src="/ai-assistant/ai-robot-loop.webp" alt="WebP 4x" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Row 3: Poster Image */}
                <div>
                    <h2 style={{ fontSize: '16px', margin: '0 0 12px 0', color: '#fb7185' }}>Format: Poster Static WebP (Reduced Motion, Static Fallback, Transparent, Mirrored)</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
                        {bgShells.map((bg) => (
                            <div key={bg.name} style={{ border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                                <div style={{ padding: '6px 12px', background: '#1e293b', fontSize: '12px', fontWeight: 'bold', color: '#94a3b8' }}>{bg.name}</div>
                                <div style={{ ...bg.style, padding: '24px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px' }}>
                                    {/* 88px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>88px (1x)</span>
                                        <div style={{ width: '88px', height: '88px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <img src="/ai-assistant/ai-robot-poster.webp" alt="Poster 1x" style={{ width: '130%', height: '130%', objectFit: 'contain' }} />
                                        </div>
                                    </div>
                                    {/* 352px size */}
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>352px (4x)</span>
                                        <div style={{ width: '352px', height: '352px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <img src="/ai-assistant/ai-robot-poster.webp" alt="Poster 4x" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

            </div>

            {/* Test Interactive Fixed Floating Button bottom-right */}
            <AnimatedAiAssistantButton
                open={isOpen}
                onClick={() => setIsOpen(!isOpen)}
                isThinking={isThinking}
            />
        </div>
    )
}

export default App
