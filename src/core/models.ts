export type ResourceType = "link" | "file" | "chat";

export type ArticleStatus =
	| "fetching"
	| "parsing"
	| "ai_reading"
	| "viewed"
	| "interacted"
	| "done"
	| "fail"
	| "thinking";

export interface TopicRef {
	id: number;
	title: string;
}

export interface ReadingItem {
	id: number;
	task_id: number;
	resource_type: ResourceType;
	resource_id: number;
	chat_id?: number | null;
	created_time: string;
	last_comment_at?: string | null;
	highlight_count: number;
	title?: string | null;
	url?: string | null;
	thumbnail?: string | null;
	status?: ArticleStatus | null;
	puzle_id: number;
	domain: string;
	domain_cn?: string | null;
	author?: string | null;
	topics?: TopicRef[] | null;
	comment_count?: number | null;
	key_point_count?: number | null;
	supplemental_count?: number | null;
}

export interface AiInsight {
	title?: string | null;
	content: string;
}

export interface ReadingSection {
	heading?: string | null;
	content: string;
}

export interface LinkReadingDetail extends ReadingItem {
	content: string;
	publish_at?: string | null;
	intro?: string | null;
	reading_time_minutes?: number | null;
	ai_insights?: AiInsight[] | null;
	sections?: ReadingSection[] | null;
	chat_history?: unknown;
}

export interface FileReadingDetail extends ReadingItem {
	file_name: string;
	human_media_type?: string | null;
	content: string;
	download_link?: string | null;
}

export interface ReadingSummary {
	key_points?: string[] | null;
	new_knowledge?: string[] | null;
	different_opinions?: string[] | null;
	related_information?: string[] | null;
}

export type HighlightType = "text" | "position" | "comment";

export type HighlightRole = "user" | "assistant";

export type HighlightCategory =
	| "key_points"
	| "related_information"
	| "different_opinions"
	| "new_knowledge"
	| "underline";

export interface HighlightLocationData {
	start_index: number;
	end_index: number;
	start_tag?: string | null;
	start_tag_index?: number | null;
	end_tag?: string | null;
	end_tag_index?: number | null;
	match_index?: number | null;
	comment_ids?: number[] | null;
}

export interface HighlightItem {
	id: number;
	highlight_type: HighlightType;
	role: HighlightRole;
	category: HighlightCategory;
	content?: string | null;
	color?: string | null;
	hidden?: boolean;
	created_at: string;
	location_data: HighlightLocationData;
}

export interface CommentItem {
	id: number;
	content: string;
	role?: HighlightRole | null;
	created_at: string;
	is_liked?: boolean;
	highlight_id?: number | null;
}

export interface TopicItem {
	id: number;
	parent_id?: number | null;
	title: string;
	note_count?: number | null;
	reading_count?: number | null;
}

export interface UserProfile {
	id: number;
	username: string;
	avatar_url?: string | null;
	has_mobile?: boolean;
	is_tourist?: boolean;
	logged?: boolean;
	onboarded?: boolean;
}

export interface ChatSession {
	id: number;
	chat_id: number;
	title?: string | null;
	status?: ArticleStatus | null;
	created_time?: string | null;
	last_comment_at?: string | null;
	puzle_id?: number | null;
}

export interface PageResponse<T> {
	items: T[];
	total: number;
	page: number;
	page_size?: number;
	pageSize?: number;
}

export function isChatReadingItem(
	item: ReadingItem
): item is ReadingItem & { resource_type: "chat"; chat_id: number } {
	return item.resource_type === "chat" && typeof item.chat_id === "number";
}
