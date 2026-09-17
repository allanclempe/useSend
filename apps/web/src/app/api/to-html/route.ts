import {
  handleToHtmlPreflight,
  handleToHtmlRequest,
} from "~/server/editor-routes";

export const dynamic = "force-dynamic";

export const POST = handleToHtmlRequest;
export const OPTIONS = handleToHtmlPreflight;
