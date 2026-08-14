import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../core/ws/history";
import type { AgentLogContent } from "../../core/ws/types";

const STICK_BOTTOM_PX = 40;

export interface MessageListProps {
	app: App;
	messages: ChatMessage[];
	streaming: boolean;
	loading?: boolean;
	error?: string | null;
	keepThinking: boolean;
}

export function MessageList({ app, messages, streaming, loading, error, keepThinking }: MessageListProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const stickRef = useRef(true);
	const streamingRef = useRef(streaming);
	streamingRef.current = streaming;

	const scrollToBottom = () => {
		const el = containerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	};

	useEffect(() => {
		scrollToBottom();
	}, [messages]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			if (streamingRef.current || stickRef.current) scrollToBottom();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const handleScroll = () => {
		const el = containerRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_PX;
	};

	return (
		<div className="puzle-chat-messages" ref={containerRef} onScroll={handleScroll}>
			{loading && <div className="puzle-chat-status">正在加载对话历史…</div>}
			{!loading && messages.length === 0 && !error && (
				<div className="puzle-chat-status">还没有消息，开始一段新对话吧</div>
			)}
			{messages.map((message, index) => (
				<MessageBubble
					key={message.id}
					app={app}
					message={message}
					streaming={streaming && index === messages.length - 1 && message.role === "assistant"}
					keepThinking={keepThinking}
				/>
			))}
			{error && <div className="puzle-chat-error">{error}</div>}
		</div>
	);
}

interface MessageBubbleProps {
	app: App;
	message: ChatMessage;
	streaming: boolean;
	keepThinking: boolean;
}

function MessageBubble({ app, message, streaming, keepThinking }: MessageBubbleProps) {
	return (
		<div className={`puzle-chat-message puzle-chat-message-${message.role}`}>
			<div className="puzle-chat-bubble">
				{message.role === "assistant" ? (
					<>
						{keepThinking && message.logs && message.logs.length > 0 && (
							<ThinkingLogs logs={message.logs} />
						)}
						{message.content ? (
							<MarkdownView app={app} content={message.content} />
						) : (
							!streaming && <span className="puzle-chat-empty">（无内容）</span>
						)}
						{streaming && <span className="puzle-chat-cursor" />}
					</>
				) : (
					<div className="puzle-chat-user-text">{message.content}</div>
				)}
			</div>
		</div>
	);
}

function MarkdownView({ app, content }: { app: App; content: string }) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.empty();
		const component = new Component();
		component.load();
		MarkdownRenderer.render(app, content, el, "", component).catch(() => undefined);
		return () => {
			component.unload();
			el.empty();
		};
	}, [app, content]);

	return <div className="puzle-chat-markdown markdown-preview-view" ref={ref} />;
}

function ThinkingLogs({ logs }: { logs: AgentLogContent[] }) {
	return (
		<details className="puzle-chat-thinking">
			<summary>思考过程</summary>
			<div className="puzle-chat-thinking-content">
				{logs.map((log, index) => {
					const text = describeLog(log);
					if (!text) return null;
					return (
						<div key={index} className="puzle-chat-thinking-item">
							{text}
						</div>
					);
				})}
			</div>
		</details>
	);
}

function describeLog(log: AgentLogContent): string {
	switch (log.type) {
		case "thinking": {
			const reasoning = typeof log.reasoning === "string" ? log.reasoning : "";
			const conclusion = typeof log.conclusion === "string" ? log.conclusion : "";
			return [reasoning, conclusion].filter(Boolean).join("\n\n");
		}
		case "observation": {
			const environment = typeof log.environment === "string" ? log.environment : "";
			const finding = typeof log.finding === "string" ? log.finding : "";
			return [environment, finding].filter(Boolean).join("\n");
		}
		case "tool_call": {
			const name = typeof log.tool_name === "string" ? log.tool_name : "tool";
			const args =
				log.tool_args === undefined || log.tool_args === null
					? ""
					: typeof log.tool_args === "string"
						? log.tool_args
						: JSON.stringify(log.tool_args);
			return args ? `${name}(${args})` : name;
		}
		case "tool_result": {
			const name = typeof log.tool_name === "string" ? log.tool_name : "tool";
			const display =
				typeof log.display === "string" && log.display
					? log.display
					: typeof log.result === "string"
						? log.result
						: "";
			return display ? `${name}: ${display}` : name;
		}
		case "error":
			return typeof log.error_message === "string" ? log.error_message : "";
		case "text":
			return typeof log.text === "string" ? log.text : "";
		default:
			return "";
	}
}
