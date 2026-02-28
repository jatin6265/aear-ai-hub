import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { 
  Wrench, 
  Search, 
  Plus, 
  Shield, 
  Zap, 
  AlertTriangle,
  ExternalLink,
  MoreVertical,
  Trash2,
  Edit3
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

type Tool = {
  id: string;
  code: string;
  display_name: string;
  description: string | null;
  category: string;
  risk_level: "low" | "medium" | "high" | "critical";
  raci_required: string;
  is_write_action: boolean;
  is_active: boolean;
  version: string;
  created_at: string;
};

export default function Tools() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (user) {
      void fetchTools();
    }
  }, [user]);

  async function fetchTools() {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("tool_registry")
        .select("*")
        .order("display_name", { ascending: true });

      if (error) throw error;
      setTools(data as Tool[]);
    } catch (error) {
      toast({
        title: "Failed to load tools",
        description: error instanceof Error ? error.message : "An unknown error occurred",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  const filteredTools = tools.filter(t => 
    t.display_name.toLowerCase().includes(search.toLowerCase()) ||
    t.code.toLowerCase().includes(search.toLowerCase()) ||
    t.category.toLowerCase().includes(search.toLowerCase())
  );

  const getRiskBadge = (level: string) => {
    switch (level) {
      case "low": return <Badge className="bg-emerald-100 text-emerald-700 border-0">Low</Badge>;
      case "medium": return <Badge className="bg-amber-100 text-amber-700 border-0">Medium</Badge>;
      case "high": return <Badge className="bg-orange-100 text-orange-700 border-0">High</Badge>;
      case "critical": return <Badge className="bg-red-100 text-red-700 border-0">Critical</Badge>;
      default: return <Badge variant="secondary">{level}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Tool Registry</h1>
          <p className="text-slate-500 text-sm">Manage AI capabilities and governance rules for automated actions.</p>
        </div>
        <Button className="gradient-cta text-white border-0 shadow-sm">
          <Plus className="w-4 h-4 mr-2" />
          Register Custom Tool
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input 
          placeholder="Search by name, code, or category..." 
          className="pl-10 max-w-md"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <Table>
          <TableHeader className="bg-slate-50/50">
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Governance</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-10 w-[200px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[80px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[100px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[60px]" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-[60px]" /></TableCell>
                  <TableCell><Skeleton className="h-8 w-8 ml-auto" /></TableCell>
                </TableRow>
              ))
            ) : filteredTools.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-slate-500">
                  {search ? "No tools match your search." : "No tools registered yet."}
                </TableCell>
              </TableRow>
            ) : (
              filteredTools.map((tool) => (
                <TableRow key={tool.id} className="group hover:bg-slate-50/50 transition-colors">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 group-hover:bg-white group-hover:shadow-sm transition-all">
                        {tool.is_write_action ? <Zap className="w-5 h-5 text-amber-500" /> : <Wrench className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="font-medium text-slate-900">{tool.display_name}</div>
                        <div className="text-xs text-slate-500 font-mono">{tool.code}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{tool.category}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 text-xs text-slate-600">
                      <Shield className="w-3.5 h-3.5 text-slate-400" />
                      RACI: {tool.raci_required}
                    </div>
                  </TableCell>
                  <TableCell>{getRiskBadge(tool.risk_level)}</TableCell>
                  <TableCell>
                    <Badge variant={tool.is_active ? "default" : "secondary"}>
                      {tool.is_active ? "Active" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-600">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem className="text-slate-600">
                          <Edit3 className="w-4 h-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-slate-600">
                          <ExternalLink className="w-4 h-4 mr-2" /> View Logs
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600 focus:text-red-600 focus:bg-red-50">
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex gap-4 items-start">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="text-sm text-slate-600">
          <p className="font-semibold text-slate-900 mb-1">Governance Notice</p>
          Critical and High-risk tools require explicit Accountable (A) approval in the RACI matrix before the AI can execute them. 
          Modify individual tool risk levels to adjust the required approval threshold.
        </div>
      </div>
    </div>
  );
}
