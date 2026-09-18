import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";

import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";

import { templateQueries } from "~/queries/template";
import DeleteTemplate from "./-delete-template";
import DuplicateTemplate from "./-duplicate-template";

const route = getRouteApi("/_dashboard/templates/");

export default function TemplateList() {
  const { page } = route.useSearch();
  const navigate = route.useNavigate();

  const templateQuery = useQuery(templateQueries.list(page));

  function goToPage(next: number) {
    void navigate({ search: { page: next } });
  }

  return (
    <div className="mt-10 flex flex-col gap-4">
      <div className="flex flex-col rounded-xl border border-border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Name</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="rounded-tr-xl">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templateQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : templateQuery.data?.templates.length ? (
              templateQuery.data.templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="font-medium">
                    <Link
                      className="text-foreground underline decoration-dashed underline-offset-4 hover:text-foreground"
                      to="/templates/$templateId/edit"
                      params={{ templateId: template.id }}
                    >
                      {template.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <TextWithCopyButton
                      value={template.id}
                      className="w-[200px] overflow-hidden"
                    />
                  </TableCell>
                  <TableCell>
                    {formatDistanceToNow(new Date(template.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <DuplicateTemplate template={template} />
                      <DeleteTemplate template={template} />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  No templates found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex justify-end gap-4">
        <Button size="sm" onClick={() => goToPage(page - 1)} disabled={page === 1}>
          Previous
        </Button>
        <Button
          size="sm"
          onClick={() => goToPage(page + 1)}
          disabled={page >= (templateQuery.data?.totalPage ?? 0)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
