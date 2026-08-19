import { useEffect, useState } from "react";
import type { CommentItem, HighlightCategory } from "../../core/models";
import type { AnnotationEntry, AnnotationsController, AnnotationsState } from "../controller";

const CATEGORY_LABELS: Record<HighlightCategory, string> = {
	key_points: "关键要点",
	new_knowledge: "新知识",
	different_opinions: "不同观点",
	related_information: "相关信息",
	underline: "划线"
};

export interface AnnotationsPanelProps {
	getController(): AnnotationsController;
	onReveal(snippet: string): void;
	onAskAboutSelection?(snippet: string): void;
}

export function AnnotationsPanel({ getController, onReveal, onAskAboutSelection }: AnnotationsPanelProps) {
	const [controller, setController] = useState<AnnotationsController | null>(null);
	const [state, setState] = useState<AnnotationsState | null>(null);

	useEffect(() => {
		const instance = getController();
		setController(instance);
		return instance.subscribe(setState);
	}, [getController]);

	if (!controller || !state) return null;

	if (!state.article) {
		return (
			<div className="puzle-annotations">
				<div className="puzle-annotations-status">打开一篇 Puzle 文章即可看到它的高亮与想法</div>
			</div>
		);
	}

	const total = state.entries.length;
	return (
		<div className="puzle-annotations">
			<div className="puzle-annotations-header">
				<span className="puzle-annotations-title" title={state.article.title}>
					{state.article.title}
				</span>
				<button
					type="button"
					className="puzle-annotations-refresh clickable-icon"
					title="刷新"
					aria-label="刷新"
					onClick={() => void controller.refresh()}
				>
					⟳
				</button>
			</div>

			{state.loading && <div className="puzle-annotations-status">正在加载批注…</div>}
			{state.error && <div className="puzle-annotations-error">{state.error}</div>}

			<section className="puzle-annotations-section">
				<div className="puzle-annotations-section-label">想法（文章级）</div>
				{state.articleComments.length === 0 && !state.loading && (
					<div className="puzle-annotations-empty">还没有想法，写下第一条吧</div>
				)}
				{state.articleComments.map((comment) => (
					<CommentLine
						key={comment.id}
						comment={comment}
						disabled={state.submitting}
						onDelete={() => controller.deleteComment(comment.id)}
					/>
				))}
				<CommentComposer
					placeholder="写下对这篇文章的想法…"
					disabled={state.submitting}
					onSubmit={(text) => controller.addArticleComment(text)}
				/>
			</section>

			<section className="puzle-annotations-section">
				<div className="puzle-annotations-section-label">高亮（{total}）</div>
				{total === 0 && !state.loading && (
					<div className="puzle-annotations-empty">这篇文章还没有高亮</div>
				)}
				{state.entries.map((entry) => (
					<HighlightCard
						key={entry.highlight.id}
						entry={entry}
						disabled={state.submitting}
						onReveal={onReveal}
						onAsk={onAskAboutSelection}
						onReply={(text) => controller.addHighlightComment(entry.highlight.id, text)}
						onDelete={() => controller.deleteHighlight(entry.highlight.id)}
						onDeleteComment={(commentId) => controller.deleteComment(commentId)}
					/>
				))}
			</section>
		</div>
	);
}

interface HighlightCardProps {
	entry: AnnotationEntry;
	disabled: boolean;
	onReveal(snippet: string): void;
	onAsk?(snippet: string): void;
	onReply(text: string): Promise<boolean>;
	onDelete(): Promise<boolean>;
	onDeleteComment(commentId: number): Promise<boolean>;
}

function HighlightCard({
	entry,
	disabled,
	onReveal,
	onAsk,
	onReply,
	onDelete,
	onDeleteComment
}: HighlightCardProps) {
	const [replying, setReplying] = useState(false);
	const content = (entry.highlight.content ?? "").trim();
	const label = CATEGORY_LABELS[entry.highlight.category];
	const byAi = entry.highlight.role === "assistant";

	return (
		<div className={`puzle-annotation-card${byAi ? " is-ai" : ""}`}>
			{(label || byAi) && (
				<div className="puzle-annotation-meta">
					{label && (
						<span className={`puzle-annotation-category puzle-category-${entry.highlight.category}`}>
							{label}
						</span>
					)}
					{byAi && <span className="puzle-annotation-role">AI 划的</span>}
				</div>
			)}
			<blockquote
				className="puzle-annotation-quote"
				role="button"
				tabIndex={0}
				title="跳转到正文位置"
				onClick={() => onReveal(content)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") onReveal(content);
				}}
			>
				{content || "（无文本）"}
			</blockquote>
			{entry.comments.map((comment) => (
				<CommentLine
					key={comment.id}
					comment={comment}
					disabled={disabled}
					onDelete={() => onDeleteComment(comment.id)}
				/>
			))}
			<div className="puzle-annotation-actions">
				<button type="button" className="puzle-annotation-action" onClick={() => setReplying((v) => !v)}>
					{replying ? "取消" : "写想法"}
				</button>
				{onAsk && (
					<button type="button" className="puzle-annotation-action" onClick={() => onAsk(content)}>
						就这段提问
					</button>
				)}
				<span className="puzle-annotation-actions-gap" />
				<DangerAction
					label="删除"
					confirmLabel="删除高亮？"
					title="删除这条高亮（它下面的想法会一起消失）"
					disabled={disabled}
					onConfirm={onDelete}
				/>
			</div>
			{replying && (
				<CommentComposer
					placeholder="对这条高亮的想法…"
					disabled={disabled}
					autoFocus
					onSubmit={async (text) => {
						const ok = await onReply(text);
						if (ok) setReplying(false);
						return ok;
					}}
				/>
			)}
		</div>
	);
}

interface CommentLineProps {
	comment: CommentItem;
	disabled?: boolean;
	onDelete(): Promise<boolean>;
}

function CommentLine({ comment, disabled, onDelete }: CommentLineProps) {
	return (
		<div className="puzle-annotation-comment">
			<span className="puzle-annotation-comment-role">
				{comment.role === "assistant" ? "🤖" : "🙋"}
			</span>
			<span className="puzle-annotation-comment-text">{comment.content}</span>
			<DangerAction
				label="×"
				confirmLabel="删除？"
				title="删除这条想法"
				disabled={disabled}
				className="puzle-annotation-comment-delete"
				onConfirm={onDelete}
			/>
		</div>
	);
}

interface DangerActionProps {
	label: string;
	confirmLabel: string;
	title: string;
	disabled?: boolean;
	className?: string;
	onConfirm(): Promise<boolean>;
}

/** 两步删除：点一下变成「确认？」，再点才真删 —— 侧边栏里不适合弹模态 */
function DangerAction({
	label,
	confirmLabel,
	title,
	disabled,
	className,
	onConfirm
}: DangerActionProps) {
	const [confirming, setConfirming] = useState(false);

	if (!confirming) {
		return (
			<button
				type="button"
				className={`puzle-annotation-action is-danger${className ? ` ${className}` : ""}`}
				title={title}
				aria-label={title}
				disabled={disabled}
				onClick={() => setConfirming(true)}
			>
				{label}
			</button>
		);
	}
	return (
		<span className="puzle-annotation-confirm">
			<button
				type="button"
				className="puzle-annotation-action is-danger"
				disabled={disabled}
				onClick={() => {
					void onConfirm().then((ok) => {
						if (!ok) setConfirming(false);
					});
				}}
			>
				{confirmLabel}
			</button>
			<button
				type="button"
				className="puzle-annotation-action"
				disabled={disabled}
				onClick={() => setConfirming(false)}
			>
				取消
			</button>
		</span>
	);
}

interface CommentComposerProps {
	placeholder: string;
	disabled?: boolean;
	autoFocus?: boolean;
	onSubmit(text: string): Promise<boolean>;
}

function CommentComposer({ placeholder, disabled, autoFocus, onSubmit }: CommentComposerProps) {
	const [text, setText] = useState("");
	const submit = () => {
		const value = text.trim();
		if (!value || disabled) return;
		void onSubmit(value).then((ok) => {
			if (ok) setText("");
		});
	};

	return (
		<div className="puzle-annotation-composer">
			<textarea
				className="puzle-annotation-input"
				rows={2}
				autoFocus={autoFocus}
				placeholder={placeholder}
				value={text}
				disabled={disabled}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			{text.trim() !== "" && (
				<button
					type="button"
					className="puzle-annotation-submit mod-cta"
					disabled={disabled}
					onClick={submit}
				>
					发表
				</button>
			)}
		</div>
	);
}
