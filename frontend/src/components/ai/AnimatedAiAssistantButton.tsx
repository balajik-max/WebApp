import { useRef, useState, useEffect } from 'react';
import './AnimatedAiAssistantButton.css';

interface AnimatedAiAssistantButtonProps {
    open: boolean;
    onClick: () => void;
    className?: string;
    isThinking?: boolean;
}

export function AnimatedAiAssistantButton({
    open,
    onClick,
    className = '',
    isThinking = false
}: AnimatedAiAssistantButtonProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [showFallback, setShowFallback] = useState(false);

    const handleVideoError = () => {
        setShowFallback(true);
    };

    const handleVideoReady = () => {
        setShowFallback(false);
    };

    // Pause video if reduced motion is preferred
    useEffect(() => {
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)');

        // Initial check
        if (mql.matches && videoRef.current) {
            videoRef.current.pause();
        }

        const handleChange = (e: MediaQueryListEvent) => {
            if (e.matches) {
                videoRef.current?.pause();
            } else {
                videoRef.current?.play().catch(() => { });
            }
        };

        mql.addEventListener('change', handleChange);
        return () => mql.removeEventListener('change', handleChange);
    }, []);

    const classes = [
        'ai-robot-button',
        open ? 'is-open' : '',
        isThinking ? 'is-thinking' : '',
        className
    ].filter(Boolean).join(' ');

    return (
        <button
            type="button"
            className={classes}
            onClick={onClick}
            aria-label="Open AI Assistant"
            aria-expanded={open}
        >
            <span className="ai-robot-button__halo" aria-hidden="true" />

            {open && <span className="ai-robot-button__ring" aria-hidden="true" />}
            {isThinking && <span className="ai-robot-button__thinking-ring" aria-hidden="true" />}

            <span className="ai-robot-button__media" aria-hidden="true">
                <video
                    ref={videoRef}
                    autoPlay
                    loop
                    muted
                    playsInline
                    preload="auto"
                    poster="/ai-assistant/ai-robot-poster.webp"
                    className="ai-robot-button__video"
                    onCanPlay={handleVideoReady}
                    onError={handleVideoError}
                >
                    <source src="/ai-assistant/ai-robot-loop.webm" type="video/webm" />
                </video>

                {showFallback && (
                    <img
                        src="/ai-assistant/ai-robot-loop.webp"
                        alt=""
                        className="ai-robot-button__fallback"
                    />
                )}
            </span>

            <span className="ai-robot-button__tooltip">
                Open AI Assistant
                <span className="ai-robot-button__tooltip-sub">Smart Urban Planning</span>
            </span>
        </button>
    );
}
