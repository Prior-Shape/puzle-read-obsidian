import { useState } from "react";
import type { KeyboardEvent } from "react";

export interface ComposerProps {
	streaming: boolean;
	disabled?: boolean;
	onSend(text: string): void;
	onStop(): void;
}

export function Composer({ streaming, disabled, onSend, onStop }: ComposerProps) {
	const [text, setText] = useState("");
	const inputDisabled = streaming || !!disabled;

	const send = () => {
		const value = text.trim();
		if (!value || inputDisabled) return;
		onSend(value);
		setText("");
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			send();
		}
	};

	return (
		<div className="puzle-chat-composer">
			<textarea
				className="puzle-chat-input"
				placeholder="输入消息，Enter 发送，Shift+Enter 换行"
				value={text}
				rows={3}
				disabled={inputDisabled}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={handleKeyDown}
			/>
			{streaming ? (
				<button type="button" className="puzle-chat-stop mod-warning" onClick={onStop} title="停止生成">
					停止
				</button>
			) : (
				<button
					type="button"
					className="puzle-chat-send mod-cta"
					onClick={send}
					disabled={inputDisabled || text.trim() === ""}
				>
					发送
				</button>
			)}
		</div>
	);
}
