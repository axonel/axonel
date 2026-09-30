import React, { useMemo, useState } from 'react';
import { WorkflowGraph, GraphNode } from '../types';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface TaskGraphViewProps {
  graph: WorkflowGraph;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}

interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
}

export const TaskGraphView: React.FC<TaskGraphViewProps> = ({
  graph,
  selectedTaskId,
  onSelectTask,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Compute Layout: Topological sort / layered DAG layout
  const { layoutNodes, layoutEdges } = useMemo(() => {
    if (!graph || graph.nodes.length === 0) {
      return { layoutNodes: [], layoutEdges: [], svgBounds: { width: 600, height: 400 } };
    }

    const nodeWidth = 220;
    const nodeHeight = 85;
    const horizontalSpacing = 120;
    const verticalSpacing = 35;

    // Build adjacency and in-degree maps
    const nodeMap = new Map<string, GraphNode>();
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();

    graph.nodes.forEach((n) => {
      nodeMap.set(n.id, n);
      inDegree.set(n.id, 0);
      outgoing.set(n.id, []);
      incoming.set(n.id, []);
    });

    graph.edges.forEach((e) => {
      if (nodeMap.has(e.from) && nodeMap.has(e.to)) {
        outgoing.get(e.from)!.push(e.to);
        incoming.get(e.to)!.push(e.from);
        inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
      }
    });

    // Compute levels (longest path from root)
    const levels = new Map<string, number>();
    const roots = graph.nodes.filter((n) => (inDegree.get(n.id) || 0) === 0);

    const computeLevel = (nodeId: string, currentLevel: number) => {
      const prev = levels.get(nodeId) || 0;
      if (currentLevel > prev) {
        levels.set(nodeId, currentLevel);
      }
      const children = outgoing.get(nodeId) || [];
      for (const child of children) {
        computeLevel(child, (levels.get(nodeId) || currentLevel) + 1);
      }
    };

    if (roots.length > 0) {
      roots.forEach((r) => computeLevel(r.id, 0));
    } else {
      // Cyclic or standalone nodes fallback
      graph.nodes.forEach((n, idx) => levels.set(n.id, idx % 3));
    }

    // Ensure all nodes have a level
    graph.nodes.forEach((n) => {
      if (!levels.has(n.id)) levels.set(n.id, 0);
    });

    // Group nodes by level
    const levelBuckets = new Map<number, GraphNode[]>();
    let maxLevel = 0;
    levels.forEach((lvl, nodeId) => {
      maxLevel = Math.max(maxLevel, lvl);
      if (!levelBuckets.has(lvl)) levelBuckets.set(lvl, []);
      levelBuckets.get(lvl)!.push(nodeMap.get(nodeId)!);
    });

    let maxNodesInLevel = 0;
    const computedNodes: LayoutNode[] = [];
    const layoutNodeMap = new Map<string, LayoutNode>();

    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const nodesInLevel = levelBuckets.get(lvl) || [];
      maxNodesInLevel = Math.max(maxNodesInLevel, nodesInLevel.length);

      nodesInLevel.forEach((n, idx) => {
        const x = 50 + lvl * (nodeWidth + horizontalSpacing);
        const y = 50 + idx * (nodeHeight + verticalSpacing);
        const ln: LayoutNode = {
          ...n,
          x,
          y,
          width: nodeWidth,
          height: nodeHeight,
          level: lvl,
        };
        computedNodes.push(ln);
        layoutNodeMap.set(n.id, ln);
      });
    }

    // Compute edge coordinates
    const computedEdges = graph.edges
      .map((e) => {
        const source = layoutNodeMap.get(e.from);
        const target = layoutNodeMap.get(e.to);
        if (!source || !target) return null;

        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x;
        const y2 = target.y + target.height / 2;
        const dx = (x2 - x1) / 2;

        return {
          id: `${e.from}->${e.to}`,
          from: e.from,
          to: e.to,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          x1,
          y1,
          x2,
          y2,
        };
      })
      .filter(Boolean) as {
      id: string;
      from: string;
      to: string;
      d: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }[];

    const totalWidth = Math.max(800, 100 + (maxLevel + 1) * (nodeWidth + horizontalSpacing));
    const totalHeight = Math.max(500, 100 + maxNodesInLevel * (nodeHeight + verticalSpacing));

    return {
      layoutNodes: computedNodes,
      layoutEdges: computedEdges,
      svgBounds: { width: totalWidth, height: totalHeight },
    };
  }, [graph]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'svg' || (e.target as HTMLElement).id === 'graph-canvas') {
      setIsDragging(true);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const getNodeBorder = (state: string, isSelected: boolean) => {
    if (isSelected) return 'stroke-sentinel-lime stroke-2';
    switch (state.toLowerCase()) {
      case 'verified':
        return 'stroke-emerald-500/70 stroke-1';
      case 'running':
      case 'verifying':
        return 'stroke-sky-400 stroke-2 animate-pulse';
      case 'blocked':
        return 'stroke-rose-600/80 stroke-1';
      case 'failed':
      case 'recovering':
        return 'stroke-amber-500/80 stroke-1';
      default:
        return 'stroke-surface-border-bold stroke-1';
    }
  };

  const getNodeFill = (state: string, isSelected: boolean) => {
    if (isSelected) return '#1A1E26';
    switch (state.toLowerCase()) {
      case 'verified':
        return '#0E1A14';
      case 'running':
      case 'verifying':
        return '#0C1824';
      case 'blocked':
        return '#211013';
      default:
        return '#111317';
    }
  };

  return (
    <div className="relative w-full h-[550px] bg-surface-base border border-surface-border rounded overflow-hidden select-none">
      {/* Canvas Controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-surface-card/90 backdrop-blur-xs border border-surface-border rounded p-1">
        <button
          onClick={() => setZoom((z) => Math.min(z + 0.15, 2.5))}
          className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-surface-hover transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setZoom((z) => Math.max(z - 0.15, 0.4))}
          className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-surface-hover transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => {
            setZoom(1);
            setPan({ x: 40, y: 40 });
          }}
          className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-surface-hover transition-colors"
          title="Reset View"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* DAG Summary overlay */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 bg-surface-card/90 backdrop-blur-xs px-3 py-1.5 rounded border border-surface-border text-[11px] font-mono text-gray-400">
        <span>Total: {graph.summary.total}</span>
        <span className="text-surface-border-bold">•</span>
        <span className="text-status-verified">Verified: {graph.summary.verified}</span>
        <span className="text-surface-border-bold">•</span>
        <span className="text-status-running">Running: {graph.summary.running}</span>
        <span className="text-surface-border-bold">•</span>
        <span className="text-gray-400">Pending: {graph.summary.pending}</span>
        {graph.summary.blocked > 0 && (
          <>
            <span className="text-surface-border-bold">•</span>
            <span className="text-status-failed">Blocked: {graph.summary.blocked}</span>
          </>
        )}
      </div>

      {/* Interactive SVG Canvas */}
      <svg
        id="graph-canvas"
        className="w-full h-full cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <defs>
          <pattern id="dag-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#171A21" strokeWidth="0.8" />
          </pattern>
          <marker
            id="dag-arrowhead"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 8 3.5, 0 7" fill="#3B4354" />
          </marker>
          <marker
            id="dag-arrowhead-active"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 8 3.5, 0 7" fill="#CCFF00" />
          </marker>
        </defs>

        <rect width="100%" height="100%" fill="url(#dag-grid)" />

        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
          {/* Edges */}
          {layoutEdges.map((edge) => {
            const isConnectedToSelected =
              edge.from === selectedTaskId || edge.to === selectedTaskId;
            return (
              <path
                key={edge.id}
                d={edge.d}
                fill="none"
                stroke={isConnectedToSelected ? '#CCFF00' : '#2C323D'}
                strokeWidth={isConnectedToSelected ? 2 : 1.2}
                markerEnd={
                  isConnectedToSelected
                    ? 'url(#dag-arrowhead-active)'
                    : 'url(#dag-arrowhead)'
                }
                strokeDasharray={isConnectedToSelected ? 'none' : '4 2'}
                className="transition-all duration-200"
              />
            );
          })}

          {/* Nodes */}
          {layoutNodes.map((node) => {
            const isSelected = node.id === selectedTaskId;
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => onSelectTask(node.id)}
                className="cursor-pointer group"
              >
                {/* Node Box */}
                <rect
                  width={node.width}
                  height={node.height}
                  rx="4"
                  fill={getNodeFill(node.state, isSelected)}
                  className={`${getNodeBorder(
                    node.state,
                    isSelected
                  )} transition-all duration-150 group-hover:stroke-sentinel-lime/80`}
                />

                {/* Node Title / Objective */}
                <text
                  x="12"
                  y="24"
                  fill="#F3F4F6"
                  fontSize="12"
                  fontWeight="600"
                  fontFamily="Inter, sans-serif"
                  className="pointer-events-none"
                >
                  {node.objective.length > 24
                    ? `${node.objective.slice(0, 23)}...`
                    : node.objective}
                </text>

                {/* State Tag */}
                <g transform="translate(12, 34)">
                  <rect
                    width="62"
                    height="16"
                    rx="2"
                    fill="#1C2027"
                    className="pointer-events-none"
                  />
                  <text
                    x="31"
                    y="11"
                    fill={
                      node.state === 'Verified'
                        ? '#22C55E'
                        : node.state === 'Running'
                        ? '#38BDF8'
                        : node.state === 'Blocked'
                        ? '#EF4444'
                        : '#9CA3AF'
                    }
                    fontSize="9"
                    fontWeight="600"
                    textAnchor="middle"
                    fontFamily="monospace"
                    className="pointer-events-none uppercase"
                  >
                    {node.state}
                  </text>
                </g>

                {/* Priority Tag */}
                <g transform="translate(80, 34)">
                  <rect
                    width="44"
                    height="16"
                    rx="2"
                    fill="#1C2027"
                    className="pointer-events-none"
                  />
                  <text
                    x="22"
                    y="11"
                    fill="#9CA3AF"
                    fontSize="9"
                    fontWeight="500"
                    textAnchor="middle"
                    fontFamily="monospace"
                    className="pointer-events-none"
                  >
                    P{node.priority}
                  </text>
                </g>

                {node.has_verification && (
                  <g transform="translate(130, 34)">
                    <rect
                      width="78"
                      height="16"
                      rx="2"
                      fill={node.verification_passed ? '#0E291C' : '#3B1317'}
                      className="pointer-events-none"
                    />
                    <text
                      x="39"
                      y="11"
                      fill={node.verification_passed ? '#22C55E' : '#EF4444'}
                      fontSize="9"
                      fontWeight="600"
                      textAnchor="middle"
                      fontFamily="monospace"
                      className="pointer-events-none"
                    >
                      {node.verification_passed ? '✓ VERIFIED' : '✗ FAILED'}
                    </text>
                  </g>
                )}

                {/* Agent Assignment Footer */}
                <text
                  x="12"
                  y="70"
                  fill={node.state === 'Running' ? '#38BDF8' : '#6B7280'}
                  fontSize="10"
                  fontFamily="monospace"
                  className="pointer-events-none"
                >
                  {node.assigned_agent_name
                    ? `Agent: ${node.assigned_agent_name}`
                    : node.assigned_agent
                    ? `Agent: ${node.assigned_agent.slice(0, 8)}...`
                    : 'Unassigned'}
                </text>

                {/* Running Pulse Indicator */}
                {node.state === 'Running' && (
                  <circle cx={node.width - 16} cy="20" r="3.5" fill="#38BDF8">
                    <animate
                      attributeName="opacity"
                      values="1;0.3;1"
                      dur="1.5s"
                      repeatCount="indefinite"
                    />
                  </circle>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};
